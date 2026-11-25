"""Watcher settings, overridable through environment variables."""

from __future__ import annotations

import os
from pathlib import Path

from scamshield import config

WATCH_DB = Path(os.environ.get("SCAMSHIELD_WATCH_DB", config.DATA_DIR / "watch.db"))
CACHE_DIR = Path(os.environ.get("SCAMSHIELD_WATCH_CACHE", config.DATA_DIR / "watch_cache"))

# Generic client name for every outbound request; no personal or team details.
USER_AGENT = os.environ.get("SCAMSHIELD_WATCH_UA", "scamshield-watch/0.1 (research crawler)")

# Sources enabled by `run`: ct, nrd, sweep (keyless). Optional: search, listings.
SOURCES = [s.strip() for s in os.environ.get("SCAMSHIELD_WATCH_SOURCES", "ct,nrd,sweep").split(",") if s.strip()]

# Minimum match score (0..1) for a hostname to be queued.
MIN_SCORE = float(os.environ.get("SCAMSHIELD_WATCH_MIN_SCORE", "0.5"))

# Engine submission.
SUBMIT_CONCURRENCY = int(os.environ.get("SCAMSHIELD_WATCH_SUBMIT_CONCURRENCY", "4"))
SUBMIT_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_WATCH_SUBMIT_TIMEOUT", "30"))
SUBMIT_INTERVAL_S = float(os.environ.get("SCAMSHIELD_WATCH_SUBMIT_INTERVAL", "5"))

# Certificate transparency.
CT_LOG_LIST_URL = "https://www.gstatic.com/ct/log_list/v3/log_list.json"
CT_OPERATORS = [s.strip() for s in os.environ.get(
    "SCAMSHIELD_WATCH_CT_OPERATORS", "Let's Encrypt,Google,Sectigo"  # where nearly all free (DV) certificates go
).split(",") if s.strip()]
CT_ONCE_ENTRIES = int(os.environ.get("SCAMSHIELD_WATCH_CT_ONCE_ENTRIES", "4096"))  # per log, --once
CT_POLL_S = float(os.environ.get("SCAMSHIELD_WATCH_CT_POLL", "10"))
CT_POLL_DEADLINE_S = float(os.environ.get("SCAMSHIELD_WATCH_CT_DEADLINE", "180"))  # per log and poll
CT_MAX_LAG = int(os.environ.get("SCAMSHIELD_WATCH_CT_MAX_LAG", "20000"))  # skip ahead if further behind

# Newly registered domains.
NRD_DAYS = int(os.environ.get("SCAMSHIELD_WATCH_NRD_DAYS", "3"))
NRD_POLL_S = float(os.environ.get("SCAMSHIELD_WATCH_NRD_POLL", "3600"))

# Look-alike sweep.
SWEEP_CONCURRENCY = int(os.environ.get("SCAMSHIELD_WATCH_SWEEP_CONCURRENCY", "200"))
SWEEP_RESOLVERS = [s.strip() for s in os.environ.get("SCAMSHIELD_WATCH_RESOLVERS", "1.1.1.1,8.8.8.8,9.9.9.9").split(",") if s.strip()]
SWEEP_RECHECK_S = float(os.environ.get("SCAMSHIELD_WATCH_SWEEP_RECHECK", str(24 * 3600)))
SWEEP_MAX_PER_BRAND = int(os.environ.get("SCAMSHIELD_WATCH_SWEEP_MAX_PER_BRAND", "3000"))

# Optional search / listings sources.
SEARCH_PROVIDERS = [s.strip() for s in os.environ.get("SCAMSHIELD_WATCH_SEARCH_PROVIDERS", "duckduckgo").split(",") if s.strip()]
SEARCH_DELAY_S = float(os.environ.get("SCAMSHIELD_WATCH_SEARCH_DELAY", "8"))
SEARCH_POLL_S = float(os.environ.get("SCAMSHIELD_WATCH_SEARCH_POLL", "21600"))
LISTINGS_PROVIDERS = [s.strip() for s in os.environ.get("SCAMSHIELD_WATCH_LISTINGS_PROVIDERS", "osm").split(",") if s.strip()]
LISTINGS_POLL_S = float(os.environ.get("SCAMSHIELD_WATCH_LISTINGS_POLL", "43200"))

