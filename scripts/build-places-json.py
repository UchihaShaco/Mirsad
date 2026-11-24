#!/usr/bin/env python3
"""Build the officer places directory from an Overture Maps download.

Reads one Overture Places GeoJSON file (fetch it first with the overturemaps
CLI, filtered to the Abu Dhabi bounding box), normalizes websites and phones,
and writes the Mirsad places JSON plus a small committed sample and manifest.

Example:
  overturemaps download --bbox=54.20,24.20,54.70,24.65 -f geojson --type=place -o abu-dhabi.geojson
  python3 scripts/build-places-json.py --input abu-dhabi.geojson \\
      --output data/places-abu-dhabi.json --release 2026-11-18.0
"""
import argparse
import datetime
import hashlib
import json
import sys
from urllib.parse import urlparse

ABU_DHABI_BBOX = [54.20, 24.20, 54.70, 24.65]
SAMPLE_SIZE = 5


def clean_url(raw):
    """Keep only absolute http(s) URLs; repair bare domains, drop the rest."""
    text = (raw or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "https://" + text
    else:
        scheme, _, rest = text.partition("://")
        text = scheme.lower() + "://" + rest
    try:
        parts = urlparse(text)
        if parts.scheme not in ("http", "https") or not parts.netloc or " " in text:
            return None
        return text
    except Exception:
        return None


def human_category(category):
    return " ".join((category or "place").split("_")).capitalize()


def build_record(feature, updated_at):
    props = feature.get("properties", {}) or {}
    coords = (feature.get("geometry", {}) or {}).get("coordinates") or [None, None]
    lng, lat = coords[0], coords[1]
    names = props.get("names") or {}
    addresses = props.get("addresses") or []
    first_address = addresses[0] if addresses else {}
    freeform = (first_address.get("freeform") or "").strip()
    locality = (first_address.get("locality") or "").strip()
    country = (first_address.get("country") or "AE").strip()
    address = ", ".join(part for part in [freeform, locality, country] if part) or None
    taxonomy = props.get("taxonomy") or {}
    category = taxonomy.get("primary") or props.get("basic_category") or "place"

    urls = []
    for raw in props.get("websites") or []:
        cleaned = clean_url(raw)
        if cleaned and cleaned not in urls:
            urls.append(cleaned)

    phones = []
    for raw in props.get("phones") or []:
        phone = (raw or "").strip()
        if phone and phone not in phones:
            phones.append(phone)

    try:
        confidence = float(props["confidence"]) if props.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None

    bits = [human_category(category)]
    if locality:
        bits.append("in " + locality)
    if freeform:
        bits.append("— " + freeform)
    description = ", ".join(bits[:2]) + (" " + bits[2] if len(bits) > 2 else "")

    return {
        "id": feature.get("id"),
        "name": names.get("primary") or "Unnamed place",
        "name_ar": None,
        "location_link": "https://www.google.com/maps/search/?api=1&query=" + str(lat) + "," + str(lng),
        "urls": urls,
        "phones": phones,
        "description": description,
        "category": str(category),
        "address": address,
        "lat": lat,
        "lng": lng,
        "confidence": confidence,
        "source": "overture",
        "updated_at": updated_at,
    }


def main():
    parser = argparse.ArgumentParser(description="Build data/places-abu-dhabi.json from Overture GeoJSON.")
    parser.add_argument("--input", required=True, help="Overture Places GeoJSON file")
    parser.add_argument("--output", required=True, help="Destination places JSON file")
    parser.add_argument("--sample", required=True, help="Destination 5-record sample fixture")
    parser.add_argument("--manifest", required=True, help="Destination manifest JSON file")
    parser.add_argument("--release", required=True, help="Overture release, e.g. 2026-11-18.0")
    parser.add_argument("--bbox", default=",".join(str(v) for v in ABU_DHABI_BBOX))
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as handle:
        collection = json.load(handle)
    updated_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    records = [build_record(feature, updated_at) for feature in collection.get("features", [])]
    records.sort(key=lambda row: (-(row["confidence"] or 0), row["name"] or ""))

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(records, handle, ensure_ascii=False, indent=2)
    with open(args.sample, "w", encoding="utf-8") as handle:
        json.dump(records[:SAMPLE_SIZE], handle, ensure_ascii=False, indent=2)

    digest = hashlib.sha256()
    with open(args.output, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    manifest = {
        "source": "overture",
        "overture_release": args.release,
        "bbox": [float(v) for v in args.bbox.split(",")],
        "built_at": updated_at,
        "records": len(records),
        "with_urls": sum(1 for row in records if row["urls"]),
        "with_phones": sum(1 for row in records if row["phones"]),
        "sha256": digest.hexdigest(),
        "generator": "scripts/build-places-json.py",
    }
    with open(args.manifest, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print("wrote %d records, sample %d, manifest %s" % (len(records), SAMPLE_SIZE, args.manifest))


if __name__ == "__main__":
    sys.exit(main())
