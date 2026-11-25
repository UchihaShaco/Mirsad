"""Loopback front for showing the Mirsad portal through a tunnel during a remote demo.

The portal answers only requests addressed to a loopback host and checks that a browser's Origin is
that same host (its DNS-rebinding guard). A tunnel delivers requests under a public name, so the portal
refuses them. This mitmproxy addon sits on loopback between the tunnel and the portal and presents each
request the way a local browser would: loopback Host, loopback Origin and Referer. Responses are
streamed, so the event stream keeps working, and redirects are pointed back at the public name.

It is a demo aid, not a deployment: it removes the protection the guard gives against a hostile web
page reaching the portal, so run it only for the demo and behind the portal's own sign-in.

    mitmdump --mode reverse:http://127.0.0.1:8788 --listen-host 127.0.0.1 --listen-port 8787 \
        --set upstream=http://127.0.0.1:8788 -s scripts/public_front.py
"""

from __future__ import annotations

from urllib.parse import urlsplit

from mitmproxy import ctx, http

PUBLIC_HEADER = "x-mirsad-public-origin"


def load(loader) -> None:
    loader.add_option("upstream", str, "http://127.0.0.1:8788", "The portal's loopback address.")


def _upstream() -> str:
    return ctx.options.upstream.rstrip("/")


def request(flow: http.HTTPFlow) -> None:
    public_host = flow.request.headers.get("host", "")
    scheme = flow.request.headers.get("x-forwarded-proto", "http")
    flow.metadata[PUBLIC_HEADER] = f"{scheme}://{public_host}"
    upstream = _upstream()
    flow.request.headers["host"] = urlsplit(upstream).netloc
    for name in ("origin", "referer"):
        value = flow.request.headers.get(name)
        if value:
            parts = urlsplit(value)
            flow.request.headers[name] = upstream + (parts.path if name == "referer" else "") + (
                f"?{parts.query}" if name == "referer" and parts.query else "")


def responseheaders(flow: http.HTTPFlow) -> None:
    flow.response.stream = True
    location = flow.response.headers.get("location")
    upstream = _upstream()
    if location and location.startswith(upstream):
        flow.response.headers["location"] = flow.metadata.get(PUBLIC_HEADER, "") + location[len(upstream):]
