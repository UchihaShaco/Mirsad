"""Scripted browsing session through the gateway's explicit proxy: the demo without a phone.

Each URL is opened like a phone browser would: HTTPS through a CONNECT tunnel (held, passed through
or refused by the gateway), plain HTTP as readable requests (checking page, block page, warning).
A line `sleep N` in the URL file pauses the session, e.g. to let a background crawl finish.
"""

import argparse
import os
import ssl
import sys
import time
from pathlib import Path

import httpx

BROWSER = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Sec-CH-UA": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": '"Android"',
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
}
STATUS_PATH = "/.well-known/scamshield/status"


def visit(client: httpx.Client, url: str, poll_s: float) -> tuple[str, str]:
    """Open one URL and return (outcome, detail)."""
    try:
        r = client.get(url, headers=BROWSER)
    except httpx.HTTPError as exc:
        return "BLOCKED", f"connection refused by the gateway ({type(exc).__name__})"
    if "Checking this site for you" in r.text:
        origin = f"{r.url.scheme}://{r.url.host}"
        deadline = time.monotonic() + poll_s
        while time.monotonic() < deadline:
            state = client.get(origin + STATUS_PATH).json()["state"]
            if state != "pending":
                break
            time.sleep(0.8)
        r = client.get(url, headers=BROWSER)
    if r.status_code == 403 and "blocked this site" in r.text:
        return "BLOCKED", "block page shown"
    if "Be careful with this site" in r.text:
        return "WARNED", "warning interstitial shown"
    if r.history:
        return "LOADED", f"HTTP {r.status_code} at {r.url} after {len(r.history)} redirect(s)"
    return "LOADED", f"HTTP {r.status_code}, {len(r.content)} bytes"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy", default=os.environ.get("SIM_PROXY", "http://gateway:8081"))
    parser.add_argument("--urls", default=os.environ.get("SIM_URLS_FILE", str(Path(__file__).with_name("sim_urls.txt"))))
    parser.add_argument("--ca", default=os.environ.get("SIM_CA", ""), help="gateway CA, for intercept mode")
    parser.add_argument("--poll", type=float, default=30.0, help="seconds to wait on a checking page")
    args = parser.parse_args()

    urls = [line.split("#", 1)[0].strip() for line in Path(args.urls).read_text().splitlines()]
    urls = [u for u in urls if u]
    verify = ssl.create_default_context()
    if args.ca and Path(args.ca).exists():
        verify.load_verify_locations(args.ca)  # intercept mode: trust the gateway CA as well
    print(f"phone-sim: browsing {len(urls)} sites through {args.proxy}\n", flush=True)
    with httpx.Client(proxy=args.proxy, verify=verify, timeout=30, follow_redirects=True, trust_env=False) as client:
        for url in urls:
            if url.startswith("sleep "):
                print(f"{'...':8} {float(url.split()[1]):5.1f}s  (waiting)", flush=True)
                time.sleep(float(url.split()[1]))
                continue
            started = time.monotonic()
            outcome, detail = visit(client, url, args.poll)
            print(f"{outcome:8} {time.monotonic() - started:5.1f}s  {url}  ({detail})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
