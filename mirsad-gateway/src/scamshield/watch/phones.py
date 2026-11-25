"""UAE phone-number extraction and normalisation, usable on any text (English or Arabic)."""

from __future__ import annotations

import re

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_D = r"[0-9٠-٩۰-۹]"
_SEP = r"[\s \-\.\(\)/]"
# A run of digits and separators that starts and ends with a digit, optionally preceded by + or 00.
_CANDIDATE = re.compile(rf"(?<![0-9٠-٩۰-۹+])(\+?{_D}(?:{_SEP}{{0,2}}{_D}){{5,15}})(?!{_SEP}?{_D})")

_NATIONAL = {
    "mobile": re.compile(r"^5[0-9]\d{7}$"),
    "landline": re.compile(r"^[234679]\d{7}$"),
    "tollfree": re.compile(r"^800\d{2,8}$"),
    "sharedcost": re.compile(r"^600\d{6}$"),
}


def to_ascii_digits(text: str) -> str:
    return text.translate(_DIGITS)


def phone_kind(canonical: str) -> str | None:
    if not canonical.startswith("+971"):
        return None
    national = canonical[4:]
    for kind, pattern in _NATIONAL.items():
        if pattern.match(national):
            return kind
    return None


def normalize_phone(raw: str) -> str | None:
    """Return a canonical `+971…` number, or None if `raw` is not a valid UAE number."""
    s = to_ascii_digits(raw).strip()
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if plus or digits.startswith("00"):
        digits = digits[2:] if digits.startswith("00") else digits
        if not digits.startswith("971"):
            return None
        national = digits[3:].lstrip("0")
    elif digits.startswith("971") and len(digits) >= 11:
        national = digits[3:].lstrip("0")
    elif digits.startswith("0"):
        national = digits[1:]
    elif digits.startswith(("800", "600")):
        national = digits
    else:
        return None
    canonical = "+971" + national
    return canonical if phone_kind(canonical) else None


def extract_phones(text: str) -> list[dict]:
    """All UAE numbers in `text`, in order of appearance: [{raw, number, kind}] (deduplicated)."""
    seen: set[str] = set()
    found: list[dict] = []
    for m in _CANDIDATE.finditer(text or ""):
        raw = m.group(1).strip()
        number = normalize_phone(raw)
        if number and number not in seen:
            seen.add(number)
            found.append({"raw": raw, "number": number, "kind": phone_kind(number)})
    return found
