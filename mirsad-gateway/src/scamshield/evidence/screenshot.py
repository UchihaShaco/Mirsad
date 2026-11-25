"""Evidence-time screenshots in a hardened, throwaway headless Chromium.

Only the case file uses this; the detection path never drives a browser. Two pictures are taken:

- "Live capture": the site loaded now, with the same mobile user agent, viewport and language the engine's
  fetcher used. A cloaking site may still treat an automated browser differently.
- "As seen by the engine": the HTML the engine captured, rendered offline with every network request
  blocked and scripts disabled, so it shows exactly what was analysed.

The browser runs with a fresh in-memory profile (nothing persisted), downloads refused, permissions
denied, service workers blocked, popups and dialogs dismissed, and the whole capture bounded in time. Every
request the live page makes passes the engine's address check, so a hostile page cannot reach this machine,
the Docker networks, the tailnet or the model servers; only http(s) to public addresses (and the demo
networks opened in SCAMSHIELD_ALLOW_NETWORKS) goes out.
"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

from ..schemas import utcnow

VIEWPORT = {"width": 390, "height": 844}
MAX_HEIGHT = 2400  # px of page kept below the fold
NAV_TIMEOUT_MS = 15_000
TOTAL_TIMEOUT_S = 40.0
FALLBACK_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/152.0.0.0 Mobile Safari/537.36"
)
FALLBACK_LANGUAGE = "en-US,en;q=0.9,ar-AE;q=0.8,ar;q=0.7"
CHROMIUM_ARGS = [
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--deny-permission-prompts",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]
LOCAL_SCHEMES = ("data", "blob", "about")  # served from memory, never from the network


def engine_identity() -> tuple[str, str]:
    """User agent and Accept-Language of the engine's mobile fetch profile, so the live capture matches it."""
    try:
        from ..engine.fetch import ACCEPT_LANGUAGE, PROFILES

        return PROFILES["mobile"].user_agent, ACCEPT_LANGUAGE
    except Exception:
        return FALLBACK_UA, FALLBACK_LANGUAGE


@dataclass
class Capture:
    png: bytes | None = None
    dom: str | None = None
    text: str | None = None  # visible text of the live page, for the cloaking comparison
    final_url: str | None = None
    title: str | None = None
    status: int | None = None
    engine_png: bytes | None = None
    engine_error: str | None = None
    browser: str | None = None
    user_agent: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None


async def _launch(pw) -> tuple[object, bool]:
    """The browser and whether Chromium's own sandbox is on."""
    try:
        return await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS, chromium_sandbox=True), True
    except Exception:
        # Containers often lack the user namespaces Chromium's sandbox needs.
        return await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS, chromium_sandbox=False), False


async def refusal(url: str) -> str | None:
    """Why the browser may not request `url`, or None. Same rules as the engine's fetcher."""
    scheme = urlsplit(url).scheme.lower()
    if scheme in LOCAL_SCHEMES:
        return None
    if scheme not in ("http", "https"):
        return f"refused: {scheme or 'no'} scheme"
    from ..engine.fetch import check_target

    error, _ = await check_target(url)
    return error


async def _guard(route) -> None:
    if await refusal(route.request.url) is None:
        await route.continue_()
    else:
        await route.abort("blockedbyclient")


async def _no_websocket(ws) -> None:
    await ws.close(code=1008, reason="blocked by evidence capture")


async def _context(browser, user_agent: str, language: str, *, javascript: bool):
    context = await browser.new_context(
        viewport=VIEWPORT,
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        user_agent=user_agent,
        locale=language.split(",")[0],
        extra_http_headers={"Accept-Language": language},
        timezone_id="Asia/Dubai",
        accept_downloads=False,
        ignore_https_errors=True,  # scam sites often have broken TLS; we still want the picture
        service_workers="block",
        java_script_enabled=javascript,
        permissions=[],
    )
    return context


async def _shoot(page) -> bytes:
    height = await page.evaluate("Math.max(document.documentElement.scrollHeight, innerHeight)")
    clip = {"x": 0, "y": 0, "width": VIEWPORT["width"], "height": min(int(height or VIEWPORT["height"]), MAX_HEIGHT)}
    return await page.screenshot(full_page=True, clip=clip, type="png", timeout=10_000)


async def _live(browser, url: str, user_agent: str, language: str, result: Capture) -> None:
    if why := await refusal(url):
        raise ValueError(f"{why}: {url[:200]}")
    context = await _context(browser, user_agent, language, javascript=True)
    try:
        await context.route("**/*", _guard)
        await context.route_web_socket("**/*", _no_websocket)
        page = await context.new_page()
        page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
        page.on("popup", lambda p: asyncio.ensure_future(p.close()))
        response = None
        try:
            response = await page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        except Exception as exc:
            if page.url in ("", "about:blank"):
                raise
            result.error = f"page did not finish loading: {type(exc).__name__}"
        await page.wait_for_timeout(1200)
        result.status = response.status if response else None
        result.final_url = page.url
        result.title = await page.title()
        result.png = await _shoot(page)
        result.dom = await page.content()
        result.text = await page.evaluate("document.body ? document.body.innerText : ''")
    finally:
        await context.close()


async def _offline(browser, html: str, user_agent: str, language: str) -> bytes:
    context = await _context(browser, user_agent, language, javascript=False)
    try:
        await context.route("**/*", lambda route: route.abort())
        page = await context.new_page()
        await page.set_content(html, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        return await _shoot(page)
    finally:
        await context.close()


def _first_line(exc: BaseException) -> str:
    text = str(exc).strip().splitlines()
    return f"{type(exc).__name__}: {text[0]}" if text else type(exc).__name__


async def _capture(url: str, engine_html: str | None, result: Capture) -> None:
    from playwright.async_api import async_playwright

    user_agent, language = engine_identity()
    result.user_agent = user_agent
    async with async_playwright() as pw:
        browser, sandboxed = await _launch(pw)
        result.browser = f"chromium {browser.version}" + ("" if sandboxed else " (without Chromium sandbox)")
        try:
            if engine_html:
                try:
                    result.engine_png = await _offline(browser, engine_html, user_agent, language)
                except Exception as exc:
                    result.engine_error = _first_line(exc)
            try:
                await _live(browser, url, user_agent, language, result)
            except Exception as exc:
                result.error = _first_line(exc)
        finally:
            await browser.close()


async def capture(url: str, engine_html: str | None = None) -> Capture:
    """Screenshot `url` live as a phone would see it, and `engine_html` rendered offline. Never raises;
    failures land in `Capture.error` / `Capture.engine_error`."""
    result = Capture(started_at=utcnow())
    if not engine_html:
        result.engine_error = "the engine recorded no page HTML for this verdict"
    if os.environ.get("SCAMSHIELD_EVIDENCE_SCREENSHOT", "1") == "0":
        result.error = "screenshots disabled by configuration"
    else:
        try:
            await asyncio.wait_for(_capture(url, engine_html, result), TOTAL_TIMEOUT_S)
        except asyncio.TimeoutError:
            result.error = result.error or f"capture exceeded {TOTAL_TIMEOUT_S:.0f} s"
        except ImportError:
            result.error = "headless Chromium (playwright) is not installed"
        except Exception as exc:
            result.error = _first_line(exc)
    result.finished_at = utcnow()
    if result.png is None and result.error is None:
        result.error = "no screenshot produced"
    if engine_html and result.engine_png is None and result.engine_error is None:
        result.engine_error = result.error or "no screenshot produced"
    return result


_WORD = re.compile(r"\w{3,}", re.UNICODE)
MIN_WORDS = 12  # parked or empty pages carry too few words for a meaningful comparison


def compare_views(live_text: str | None, live_title: str | None, engine_text: str | None,
                  engine_title: str | None) -> dict:
    """How far the live page differs from what the engine analysed. A material difference suggests the site
    shows automated browsers (or the engine) something other than what people see: cloaking."""
    a = {w.lower() for w in _WORD.findall(live_text or "")}
    b = {w.lower() for w in _WORD.findall(engine_text or "")}
    if live_text is None or engine_text is None or min(len(a), len(b)) < MIN_WORDS:
        return {"compared": False, "differs": None, "similarity": None, "notes": ["too little text on one side to compare"]}
    similarity = len(a & b) / len(a | b) if a | b else 1.0
    notes = []
    if similarity < 0.5:
        notes.append(f"visible text overlaps only {similarity:.0%}")
    if (live_title or "").strip().lower() != (engine_title or "").strip().lower():
        notes.append(f'titles differ: live "{(live_title or "").strip()[:80]}" vs engine "{(engine_title or "").strip()[:80]}"')
    return {"compared": True, "differs": similarity < 0.5, "similarity": round(similarity, 3), "notes": notes}
