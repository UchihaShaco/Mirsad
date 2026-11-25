"""Campaign linking: cluster scam / suspicious domains that share infrastructure or phishing-kit fingerprints.

Every flagged verdict becomes a node. Pairs of nodes get weighted evidence (same exfiltration endpoint,
same tracker id, certificate listing both, same non-CDN IP, same name-server pair + registrar + registration
window, near-identical page hashes, same fake phone number, same brand with the same naming pattern, ...).
A pair is linked when its evidence reaches `LINK_THRESHOLD`; campaigns are the connected components
(union-find). Values shared by huge numbers of unrelated sites (CDN and parking addresses, default registrar
name servers, a registrar on its own, values seen on many nodes) never count.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

from scamshield import config
from scamshield.intel import lists
from scamshield.schemas import Decision, Verdict, utcnow
from scamshield.watch import settings
from scamshield.watch.brands import load_brands
import tldextract

from scamshield.watch.infra import is_marketplace_host, is_parking_ip, is_shared_ip, is_shared_ns
from scamshield.watch.match import registered_domain, split_host
from scamshield.watch.phones import extract_phones

LINK_THRESHOLD = 1.0
COMMON_MIN_NODES = 25  # a value present on this many nodes is too common to link anything
REGISTRATION_WINDOW_DAYS = 3

# Per-kind weight: one shared value of this kind adds this much evidence (kinds do not stack within themselves).
WEIGHTS = {
    "san": 1.0,  # one certificate lists both domains
    "exfil": 1.0,  # same Telegram bot / webhook / collection endpoint
    "tracker": 1.0,  # same analytics / pixel / ad account id
    "phone": 1.0,  # same non-official phone number on the page
    "form_action": 1.0,  # forms post to the same external collection endpoint (URL without query)
    "ip": 0.7,  # same dedicated IP address
    "structure_hash": 0.7,  # near-identical DOM structure (kit)
    "content_hash": 0.6,
    "ns_pair": 0.5,  # same name-server pair (not a registrar / host default)
    "registration": 0.5,  # same name servers + registrar, registered within a few days of each other
    "favicon": 0.4,
    "naming": 0.4,  # same impersonated brand and the same naming pattern
    "subnet": 0.3,  # same /24, different address
    "redirect": 0.8,  # both redirect to the same off-site landing domain
}

_TELEGRAM = re.compile(r"api\.telegram\.org/bot(\d{6,12}):[A-Za-z0-9_-]{20,}")
_TELEGRAM_CHAT = re.compile(r"chat_id['\"]?\s*[:=]\s*['\"]?(-?\d{6,15})")
_WEBHOOK = re.compile(r"(?:discord(?:app)?\.com/api/webhooks/\d+|webhook\.site/[0-9a-f-]{36}|hooks\.slack\.com/services/[A-Z0-9/]+"
                      r"|script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}|formspree\.io/f/\w+|getform\.io/f/\w+"
                      r"|(?<![a-z0-9-])[a-z0-9-]{1,63}\.ngrok(?:-free)?\.(?:io|app)|pipedream\.net/\w+"
                      r"|(?<![a-z0-9])[a-z0-9]{1,63}\.m\.pipedream\.net)", re.I)
_TRACKERS = (
    ("ga", re.compile(r"\bUA-\d{4,10}-\d{1,4}\b")),
    ("ga4", re.compile(r"\bG-[A-Z0-9]{8,12}\b")),
    ("gtm", re.compile(r"\bGTM-[A-Z0-9]{5,8}\b")),
    ("gads", re.compile(r"\bAW-\d{8,12}\b")),
    ("adsense", re.compile(r"\bca-pub-\d{10,20}\b")),
    ("fbpixel", re.compile(r"fbq\(\s*['\"]init['\"]\s*,\s*['\"](\d{10,20})['\"]")),
    ("yandex", re.compile(r"\bym\(\s*(\d{6,10})\s*,")),
    ("tiktok", re.compile(r"ttq\.load\(\s*['\"]([A-Z0-9]{15,25})['\"]")),
)
_COMMON_FORM_HOSTS = lists.words("services", "common_form_hosts")


def _db_path() -> Path:
    return Path(settings.WATCH_DB)


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=DELETE")  # engine (root, in Docker) and watcher share this file
    db.executescript("""
        CREATE TABLE IF NOT EXISTS campaign_nodes (
            domain TEXT PRIMARY KEY, url TEXT, verdict_id TEXT, brand TEXT, decision TEXT, risk_score REAL,
            first_seen TEXT, last_seen TEXT, features TEXT NOT NULL, campaign_id TEXT);
        CREATE TABLE IF NOT EXISTS campaign_edges (
            a TEXT NOT NULL, b TEXT NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (a, b));
    """)
    try:
        yield db
        db.commit()
    finally:
        db.close()


# Feature extraction


def _ham(a: str, b: str) -> int | None:
    if not a or not b or len(a) != len(b):
        return None
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return None


def _official_phones() -> set[str]:
    return {p for b in load_brands() for p in b.phones}


def _naming_shape(domain: str, brand_words: set[str]) -> str:
    """`uaepass-verify-24.top` -> `<brand>-verify-#.top`: the template a kit operator registers from."""
    _sub, label, suffix = split_host(domain)
    for w in sorted(brand_words, key=len, reverse=True):
        if w and w in label:
            label = label.replace(w, "<brand>")
            break
    label = re.sub(r"\d+", "#", label)
    return f"{label}.{suffix.rsplit('.', 1)[-1]}"


# Private suffixes too (github.io, pages.dev, vercel.app): every user site there is its own node.
_private_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None, include_psl_private_domains=True)
MIN_PAGE_TEXT = 80  # characters of visible text before page hashes may link anything
MAX_SANS = 20  # certificates listing more names are shared hosting / CDN certificates, not one operator's


def node_domain(host: str) -> str:
    ext = _private_extract(host)
    return f"{ext.domain}.{ext.suffix}" if ext.suffix and ext.domain else host


_INFRA_KINDS = ("ip", "subnet", "san", "ns", "registrar", "created")


def on_platform(domain: str) -> bool:
    """A user site on a hosting platform (x.pages.dev, x.vercel.app, x.blogspot.com) or the platform itself:
    its name servers, registrar, addresses and certificate belong to the platform, not to the site's owner."""
    ext = _private_extract(domain)
    return not ext.domain or registered_domain(domain) != node_domain(domain)


def _parked(v: Verdict, final_host: str) -> bool:
    """For-sale / parking / registrar placeholder: the page belongs to the marketplace, not the owner."""
    if is_marketplace_host(final_host):
        return True
    if v.page and any(is_marketplace_host(f.action_host) for f in v.page.forms if f.action_host):
        return True
    return bool(v.domain and v.domain.ips and all(is_parking_ip(ip) for ip in v.domain.ips))


def features(v: Verdict) -> dict:
    d, p = v.domain, v.page
    host = (v.host or urlsplit(v.url).hostname or "").lower()
    rd = node_domain(host)
    f: dict = {"domain": rd, "brand": v.brand.brand if v.brand else None}
    final_host = (urlsplit(v.final_url).hostname or "").lower() if v.final_url else ""
    f["parked"] = _parked(v, final_host)
    final_rd = node_domain(final_host) if final_host else ""
    f["redirect"] = [final_rd] if final_rd and final_rd != rd and not f["parked"] else []
    html = (p.html if p else "") or ""
    text = (p.text if p else "") or ""
    blob = html + "\n" + "\n".join(e for s in (p.scripts if p else []) for e in s.endpoints)
    if d:
        f["ip"] = sorted({ip for ip in d.ips if not is_shared_ip(ip, d.asn_org) and not d.is_shared_hosting})
        f["subnet"] = sorted({str(ipaddress.ip_network(f"{ip}/24", strict=False)) for ip in f["ip"] if ":" not in ip})
        ns = sorted({n.lower().rstrip(".") for n in d.nameservers})
        if ns:
            pair = "|".join(ns)
            f["ns"] = pair
            f["ns_shared"] = all(is_shared_ns(n) for n in ns)
        f["registrar"] = (d.registrar or "").strip().lower() or None
        f["created"] = d.created.date().isoformat() if d.created else None
        sans = {node_domain(s.removeprefix("*.")) for s in d.tls_sans} - {rd}
        f["san"] = sorted(sans) if len(sans) <= MAX_SANS else []
    if p:
        f["favicon"] = p.favicon_hash
        # Near-empty shells (JS-only loaders, blank challenge pages) all hash alike; their hashes prove nothing.
        thin = p.needs_js or len(p.text or "") < MIN_PAGE_TEXT
        f["structure_hash"] = None if thin else p.structure_hash
        f["content_hash"] = None if thin else p.content_hash
        actions = set()
        for form in p.forms:
            if form.external_action and form.action_host:
                ah = form.action_host.lower()
                if not any(ah == c or ah.endswith("." + c) for c in _COMMON_FORM_HOSTS):
                    actions.add(form.action.split("?")[0].lower() or ah)
        f["form_action"] = sorted(actions)
    exfil = {f"telegram:{m}" for m in _TELEGRAM.findall(blob)}
    if exfil:
        exfil |= {f"telegram_chat:{m}" for m in _TELEGRAM_CHAT.findall(blob)}
    exfil |= {m.lower() for m in _WEBHOOK.findall(blob)}
    f["exfil"] = sorted(exfil)
    trackers = set()
    for kind, rx in _TRACKERS:
        trackers |= {f"{kind}:{m}" for m in rx.findall(html)}
    f["tracker"] = sorted(trackers)
    official = _official_phones()
    f["phone"] = sorted({ph["number"] for ph in extract_phones(text) if ph["number"] not in official})
    if f["brand"]:
        b = next((x for x in load_brands() if x.name == f["brand"]), None)
        words = set(b.keywords) | {split_host(dd)[1] for dd in b.official_domains} if b else set()
        f["naming"] = _naming_shape(rd, words)
    return f


# Pair evidence


_LIST_KINDS = ("san", "exfil", "tracker", "phone", "form_action", "ip", "subnet", "redirect")


def pair_reasons(a: dict, b: dict, common: set[tuple[str, str]]) -> list[dict]:
    """Shared attributes between two nodes, each with its kind, value and weight."""
    out: list[dict] = []
    if a.get("parked") or b.get("parked"):
        return out  # a for-sale / parking lander shows the marketplace's page, not the owner's kit
    if on_platform(a["domain"]) or on_platform(b["domain"]):
        a, b = ({k: v for k, v in f.items() if k not in _INFRA_KINDS} for f in (a, b))

    def add(kind: str, value: str, weight: float | None = None) -> None:
        if (kind, value) not in common:
            out.append({"kind": kind, "value": value, "weight": WEIGHTS[kind] if weight is None else weight})

    small = lambda f: len(f.get("san") or []) <= MAX_SANS  # noqa: E731
    if (b["domain"] in a.get("san", []) and small(a)) or (a["domain"] in b.get("san", []) and small(b)):
        add("san", f"{a['domain']} + {b['domain']}")
    for kind in _LIST_KINDS:
        if kind == "san":
            continue
        shared = set(a.get(kind) or []) & set(b.get(kind) or [])
        if kind == "subnet" and set(a.get("ip") or []) & set(b.get("ip") or []):
            continue  # already counted as the same IP
        for value in sorted(shared):
            add(kind, value)
    if a.get("ns") and a.get("ns") == b.get("ns"):
        same_reg = a.get("registrar") and a.get("registrar") == b.get("registrar")
        close = False
        if same_reg and a.get("created") and b.get("created"):
            delta = abs(datetime.fromisoformat(a["created"]) - datetime.fromisoformat(b["created"]))
            close = delta.days <= REGISTRATION_WINDOW_DAYS
        if not a.get("ns_shared"):
            add("ns_pair", a["ns"])
        if close:  # default registrar name servers make this far weaker: thousands register there every day
            add("registration", f"{a['ns']} / {a['registrar']} / within {REGISTRATION_WINDOW_DAYS}d",
                WEIGHTS["registration"] / 2 if a.get("ns_shared") else None)
    for kind in ("structure_hash", "content_hash"):
        dist = _ham(a.get(kind) or "", b.get(kind) or "")
        if dist is not None and dist <= config.HASH_SAME_PAGE_DISTANCE and int(a[kind], 16) != 0:
            scale = 1.0 if dist <= config.HASH_SAME_PAGE_DISTANCE // 2 else 0.75
            add(kind, f"hamming {dist}" if dist else a[kind], WEIGHTS[kind] * scale)
    if a.get("favicon") and a.get("favicon") == b.get("favicon"):
        add("favicon", a["favicon"])
    if a.get("brand") and a.get("brand") == b.get("brand") and a.get("naming") and a.get("naming") == b.get("naming"):
        add("naming", f"{a['brand']}: {a['naming']}")
    return out


def edge_weight(reasons: list[dict]) -> float:
    best: dict[str, float] = {}
    for r in reasons:
        best[r["kind"]] = max(best.get(r["kind"], 0.0), r["weight"])
    return round(sum(best.values()), 3)


def _value_counts(nodes: list[dict]) -> dict[tuple[str, str], int]:
    counts: dict[tuple[str, str], int] = {}
    for f in nodes:
        values = {(k, v) for k in _LIST_KINDS if k != "san" for v in f.get(k) or []}
        for k in ("ns", "favicon"):
            if f.get(k):
                values.add(("ns_pair" if k == "ns" else k, f[k]))
        for kv in values:
            counts[kv] = counts.get(kv, 0) + 1
    return counts


def _common(nodes: list[dict]) -> set[tuple[str, str]]:
    return {kv for kv, n in _value_counts(nodes).items() if n >= COMMON_MIN_NODES}


# Clustering


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def _parked_node(row: sqlite3.Row) -> bool:
    """Also recognises nodes stored before `parked` was recorded, from their final URL and form endpoints."""
    f = json.loads(row["features"])
    return bool(f.get("parked") or is_marketplace_host(urlsplit(row["url"] or "").hostname)
                or any(is_marketplace_host(urlsplit(a).hostname or a) for a in f.get("form_action") or []))


def _clusters(db: sqlite3.Connection) -> tuple[dict[str, list[sqlite3.Row]], list[tuple[str, str, list[dict]]]]:
    nodes = {r["domain"]: r for r in db.execute("SELECT * FROM campaign_nodes") if not _parked_node(r)}
    common = _common([json.loads(r["features"]) for r in nodes.values()])
    uf = _UnionFind()
    links = []
    for e in db.execute("SELECT * FROM campaign_edges"):
        reasons = [r for r in json.loads(e["reasons"])
                   if (r["kind"], r["value"]) not in common]
        if e["a"] in nodes and e["b"] in nodes and edge_weight(reasons) >= LINK_THRESHOLD:
            uf.union(e["a"], e["b"])
            links.append((e["a"], e["b"], reasons))
    groups: dict[str, list[sqlite3.Row]] = {}
    for dom in nodes:
        groups.setdefault(uf.find(dom), []).append(nodes[dom])
    return groups, links


def _campaign_id(members: list[sqlite3.Row]) -> str:
    seed = min(members, key=lambda r: (r["first_seen"] or "", r["domain"]))["domain"]
    return "cmp-" + hashlib.sha1(seed.encode()).hexdigest()[:10]


def _assign(db: sqlite3.Connection) -> dict[str, str | None]:
    groups, _links = _clusters(db)
    out: dict[str, str | None] = {}
    for members in groups.values():
        cid = _campaign_id(members) if len(members) > 1 else None
        for m in members:
            out[m["domain"]] = cid
    db.executemany("UPDATE campaign_nodes SET campaign_id=? WHERE domain=?", [(c, d) for d, c in out.items()])
    return out


def link_campaign(verdict: Verdict) -> str | None:
    """Add a scam / suspicious verdict to the campaign graph; return its campaign id if it joins a cluster."""
    if verdict.decision == Decision.ALLOW or (verdict.domain and verdict.domain.allowlisted):
        return None
    f = features(verdict)
    dom = f["domain"]
    if not dom:
        return None
    now = (verdict.updated_at or utcnow()).isoformat()
    with _connect() as db:
        row = db.execute("SELECT first_seen FROM campaign_nodes WHERE domain=?", (dom,)).fetchone()
        first = row["first_seen"] if row else (verdict.created_at or utcnow()).isoformat()
        db.execute(
            """INSERT INTO campaign_nodes(domain, url, verdict_id, brand, decision, risk_score, first_seen, last_seen, features)
               VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET url=excluded.url, verdict_id=excluded.verdict_id,
               brand=excluded.brand, decision=excluded.decision, risk_score=excluded.risk_score, last_seen=excluded.last_seen,
               features=excluded.features""",
            (dom, verdict.final_url or verdict.url, verdict.id, f["brand"], verdict.decision.value, verdict.risk_score,
             first, now, json.dumps(f)),
        )
        others = [(r["domain"], json.loads(r["features"])) for r in db.execute(
            "SELECT domain, features FROM campaign_nodes WHERE domain != ?", (dom,))]
        common = _common([f] + [o for _, o in others])
        db.execute("DELETE FROM campaign_edges WHERE a=? OR b=?", (dom, dom))
        edges = []
        for other, of in others:
            reasons = pair_reasons(f, of, common)
            if reasons:
                a, b = sorted((dom, other))
                edges.append((a, b, json.dumps(reasons)))
        db.executemany("INSERT OR REPLACE INTO campaign_edges(a, b, reasons) VALUES (?,?,?)", edges)
        return _assign(db).get(dom)


_DESCRIBE = {
    "san": "one certificate covers both ({})",
    "exfil": "same exfiltration endpoint {}",
    "tracker": "same tracker id {}",
    "phone": "same phone number {}",
    "form_action": "forms post to the same endpoint {}",
    "ip": "same IP {}",
    "subnet": "same /24 network {}",
    "ns_pair": "same nameservers {}",
    "registration": "same nameservers + registrar, registered close together ({})",
    "structure_hash": "near-identical page structure ({})",
    "content_hash": "near-identical page content ({})",
    "favicon": "same favicon {}",
    "naming": "same brand and naming pattern ({})",
    "redirect": "both redirect to {}",
}


def describe(reason: dict) -> str:
    value = str(reason["value"])
    if reason["kind"] == "ns_pair":
        value = ", ".join(value.split("|"))
    if reason["kind"] == "exfil" and value.startswith("telegram:"):
        return f"same Telegram bot {value.split(':', 1)[1]}"
    return _DESCRIBE[reason["kind"]].format(value)


def rebuild_edges() -> int:
    """Recompute every edge from the stored node features (after a rule or weight change). Returns edge count."""
    with _connect() as db:
        rows = [(r["domain"], json.loads(r["features"])) for r in db.execute("SELECT domain, features FROM campaign_nodes")]
        common = _common([f for _, f in rows])
        edges = []
        for i, (da, fa) in enumerate(rows):
            for db_, fb in rows[i + 1:]:
                reasons = pair_reasons(fa, fb, common)
                if reasons:
                    a, b = sorted((da, db_))
                    edges.append((a, b, json.dumps(reasons)))
        db.execute("DELETE FROM campaign_edges")
        db.executemany("INSERT OR REPLACE INTO campaign_edges(a, b, reasons) VALUES (?,?,?)", edges)
        _assign(db)
    return len(edges)


def _watch_brands(db: sqlite3.Connection) -> dict[str, str]:
    """Brand hints the watcher recorded for its candidates, for nodes whose verdict named no brand."""
    try:
        return {r[0]: r[1] for r in db.execute(
            "SELECT registered_domain, brand_hint FROM candidates WHERE brand_hint IS NOT NULL")}
    except sqlite3.OperationalError:
        return {}


def _shared_attributes(links: list[tuple[str, str, list[dict]]]) -> list[dict]:
    agg: dict[tuple[str, str], set[str]] = {}
    for a, b, reasons in links:
        for r in reasons:
            agg.setdefault((r["kind"], r["value"]), set()).update((a, b))
    return sorted(({"kind": k, "value": v, "domains": sorted(ds)} for (k, v), ds in agg.items()),
                  key=lambda x: (-len(x["domains"]), x["kind"]))


def _label(brands: list[str], size: int, shared: list[dict]) -> str:
    target = " / ".join(brands[:3]) if brands else "unattributed"
    top = f", linked by {shared[0]['kind'].replace('_', ' ')}" if shared else ""
    return f"{target}: {size} domains{top}"


def list_campaigns() -> list[dict]:
    """Every campaign (two or more linked domains) in the dashboard's graph shape:
    {id, label, domains: [{host, decision, risk_score, verdict_id}], links: [{source, target, shared}]}
    plus size, brands, first/last seen, weights and a summary of the shared attributes."""
    with _connect() as db:
        _assign(db)
        groups, links = _clusters(db)
        hints = _watch_brands(db)
    out = []
    for members in groups.values():
        if len(members) < 2:
            continue
        names = {m["domain"] for m in members}
        clinks = [l for l in links if l[0] in names]
        brand_of = {m["domain"]: m["brand"] or hints.get(m["domain"]) for m in members}
        brands = sorted({b for b in brand_of.values() if b})
        shared = _shared_attributes(clinks)
        out.append({
            "id": _campaign_id(members),
            "label": _label(brands, len(members), shared),
            "domains": [{"host": m["domain"], "decision": m["decision"], "risk_score": m["risk_score"],
                         "verdict_id": m["verdict_id"], "url": m["url"], "brand": brand_of[m["domain"]],
                         "first_seen": m["first_seen"]}
                        for m in sorted(members, key=lambda r: r["first_seen"] or "")],
            "links": [{"source": a, "target": b, "shared": [describe(x) for x in r], "weight": edge_weight(r)}
                      for a, b, r in clinks],
            "size": len(members),
            "brands": brands,
            "first_seen": min(m["first_seen"] for m in members),
            "last_seen": max(m["last_seen"] for m in members),
            "shared_attributes": shared,
        })
    return sorted(out, key=lambda c: (-c["size"], c["first_seen"]))
