"""Central settings, overridable through environment variables."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("SCAMSHIELD_ROOT", Path(__file__).resolve().parents[2]))
DATA_DIR = Path(os.environ.get("SCAMSHIELD_DATA", ROOT / "data"))
MODEL_DIR = Path(os.environ.get("SCAMSHIELD_MODELS", ROOT / "ml" / "artifacts"))
DB_PATH = Path(os.environ.get("SCAMSHIELD_DB", DATA_DIR / "scamshield.db"))
EVIDENCE_DIR = Path(os.environ.get("SCAMSHIELD_EVIDENCE", DATA_DIR / "evidence"))

API_HOST = os.environ.get("SCAMSHIELD_API_HOST", "0.0.0.0")
API_PORT = int(os.environ.get("SCAMSHIELD_API_PORT", "8000"))
ENGINE_URL = os.environ.get("SCAMSHIELD_ENGINE_URL", f"http://localhost:{API_PORT}")

# Risk score thresholds (0..100).
WARN_THRESHOLD = float(os.environ.get("SCAMSHIELD_WARN", "35"))
BLOCK_THRESHOLD = float(os.environ.get("SCAMSHIELD_BLOCK", "70"))

# Time budgets.
FETCH_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_FETCH_TIMEOUT", "8"))
PAGE_LAYER_BUDGET_S = float(os.environ.get("SCAMSHIELD_PAGE_BUDGET", "6"))
DEEP_CRAWL_MAX_PAGES = int(os.environ.get("SCAMSHIELD_DEEP_PAGES", "25"))
DEEP_CRAWL_BUDGET_S = float(os.environ.get("SCAMSHIELD_DEEP_BUDGET", "60"))
MAX_REDIRECTS = int(os.environ.get("SCAMSHIELD_MAX_REDIRECTS", "10"))

# A cached verdict is reused while the page's fuzzy hash stays within this Hamming distance (of 64 bits).
HASH_SAME_PAGE_DISTANCE = int(os.environ.get("SCAMSHIELD_HASH_DISTANCE", "6"))
VERDICT_TTL_S = int(os.environ.get("SCAMSHIELD_VERDICT_TTL", "3600"))

# Public blocklists pre-fill the reputation table. "0" switches them off, which is how the benchmark
# measures what the engine detects by itself on sites no feed has listed yet.
USE_BLOCKLISTS = os.environ.get("SCAMSHIELD_BLOCKLISTS", "1").lower() not in ("0", "false", "no", "off")

# Layer 4: second-opinion review of every block, run in the background ("0" disables).
REVIEW_ENABLED = os.environ.get("SCAMSHIELD_REVIEW", "1").lower() not in ("0", "false", "no", "off")

# Optional LLM judge (OpenAI-compatible endpoint, e.g. a local model server). Empty = disabled.
LLM_BASE_URL = os.environ.get("SCAMSHIELD_LLM_BASE_URL", "")
LLM_MODEL = os.environ.get("SCAMSHIELD_LLM_MODEL", "")
LLM_API_KEY = os.environ.get("SCAMSHIELD_LLM_API_KEY", "")
