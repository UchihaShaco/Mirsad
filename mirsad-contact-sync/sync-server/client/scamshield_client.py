"""Drop-in helper for the Telegram bot / web dashboard (stdlib only, no pip install).

    from scamshield_client import ScamShield
    ss = ScamShield()                       # reads SCAMSHIELD_URL / SCAMSHIELD_ADMIN_TOKEN from env
    ss.flag("+65 9123 4567", label="@fake_dhl", source="telegram-bot")
    ss.set_active("+6591234567", False)     # dashboard switch off -> number removed from phones
    ss.toggle("+6591234567")                # flip
    ss.unflag("+6591234567")                # delete completely

Every call is pushed to connected phones within ~1 second.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional


class ScamShieldError(RuntimeError):
    pass


class ScamShield:
    def __init__(self, base_url: Optional[str] = None, admin_token: Optional[str] = None, timeout: float = 5.0):
        self.base = (base_url or os.environ.get("SCAMSHIELD_URL", "http://localhost:8080")).rstrip("/")
        self.token = admin_token or os.environ.get("SCAMSHIELD_ADMIN_TOKEN", "")  # empty = server in open mode
        self.timeout = timeout

    def _req(self, method: str, path: str, body: Optional[dict] = None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            raise ScamShieldError(f"{method} {path} -> {e.code}: {e.read().decode(errors='replace')}") from None

    @staticmethod
    def _p(phone: str) -> str:
        return urllib.parse.quote(phone, safe="")

    def flag(self, phone: str, label: str | None = None, note: str | None = None, source: str | None = None) -> dict:
        """Mark as scammer (creates or re-activates)."""
        return self._req("POST", "/api/v1/scammers",
                         {"phone": phone, "active": True, "label": label, "note": note, "source": source})

    def set_active(self, phone: str, active: bool) -> dict:
        return self._req("PATCH", f"/api/v1/scammers/{self._p(phone)}", {"active": active})

    def toggle(self, phone: str) -> dict:
        return self._req("POST", f"/api/v1/scammers/{self._p(phone)}/toggle")

    def unflag(self, phone: str) -> dict:
        return self._req("DELETE", f"/api/v1/scammers/{self._p(phone)}")

    def bulk_flag(self, phones: list[str], source: str | None = None) -> dict:
        return self._req("POST", "/api/v1/scammers/bulk", {"phones": phones, "source": source})

    def list(self) -> dict:
        return self._req("GET", "/api/v1/scammers")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        sys.exit("usage: scamshield_client.py flag|unflag|toggle|on|off <phone>")
    cmd, phone = sys.argv[1], sys.argv[2]
    ss = ScamShield()
    fn = {"flag": ss.flag, "unflag": ss.unflag, "toggle": ss.toggle,
          "on": lambda p: ss.set_active(p, True), "off": lambda p: ss.set_active(p, False)}[cmd]
    print(json.dumps(fn(phone), indent=2))
