"""Shared-infrastructure knowledge: addresses and name servers used by huge numbers of unrelated sites.

Two scam domains both sitting behind Cloudflare, or both parked at GoDaddy, says nothing about who runs
them, so these values must never link domains into a campaign (or mark a look-alike as brand-owned).
"""

from __future__ import annotations

import ipaddress
from functools import lru_cache

from scamshield.intel import lists

# CDN / hosting networks and organisations, default name servers of large registrars, and parking landers
# (intel/data/services.json).
_SHARED_NETS = lists.words("services", "shared_networks")
_SHARED_ORGS = lists.words("services", "shared_hosting_orgs")
_SHARED_NS = lists.words("services", "shared_nameservers")
_PARKING_NETS = lists.words("services", "parking_networks")


def is_parking_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in ipaddress.ip_network(n) for n in _PARKING_NETS)


@lru_cache(maxsize=1)
def _nets() -> tuple:
    return tuple(ipaddress.ip_network(n) for n in _SHARED_NETS)


def is_shared_ip(ip: str, asn_org: str | None = None) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_link_local:
        return True
    if asn_org and any(o in asn_org.lower() for o in _SHARED_ORGS):
        return True
    return any(addr in n for n in _nets() if n.version == addr.version)


def is_shared_ns(ns: str) -> bool:
    ns = ns.lower().rstrip(".")
    return any(ns == s or ns.endswith("." + s) for s in _SHARED_NS)


# Many unrelated for-sale names redirect to the same marketplace or parking page.
_MARKETPLACES = lists.words("services", "domain_marketplaces")


def is_marketplace_host(host: str | None) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == m or host.endswith("." + m) for m in _MARKETPLACES)
