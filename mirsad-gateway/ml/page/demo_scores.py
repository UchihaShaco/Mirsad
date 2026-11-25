"""Page-model scores of the six demo scenarios, fetched by the engine's own `fetch_page` (run inside the
engine container, where the demo hosts resolve), with and without the GPU encoder tier:

    docker compose exec -T -e SCAMSHIELD_PAGE_ENCODER_URL=http://host.docker.internal:8003 engine \
        python - < ml/page/demo_scores.py
"""

from __future__ import annotations

import asyncio
import json
import os

SCENARIOS = [
    ("a clean small business", "http://oasisroastery.com/"),
    ("b traffic-fine payment lure", "http://uae-trafficfines-pay.com/"),
    ("c short link with hidden redirects", "http://go2ae.link/r/fine"),
    ("d clean tour operator (home page)", "http://sandrosetours.com/"),
    ("e cloaking parcel-fee scam", "http://epost-redelivery-ae.com/"),
    ("f empty page with scrambled script", "http://appupdate-cdn-ae.net/"),
]


async def main() -> None:
    from scamshield.engine import fetch_page
    from scamshield.models import page_model

    url = os.environ.get("SCAMSHIELD_PAGE_ENCODER_URL", "")
    out = []
    for name, u in SCENARIOS:
        snap = await fetch_page(u)
        os.environ["SCAMSHIELD_PAGE_ENCODER_URL"] = ""
        cpu = page_model.score_page(snap)
        os.environ["SCAMSHIELD_PAGE_ENCODER_URL"] = url
        served = page_model.score_page(snap)
        path = page_model.info()["gpu_tier"]["last_path"]
        out.append({"scenario": name, "final_url": snap.final_url, "cpu": cpu, "served": served, "path": path,
                    "top": page_model.top_features(snap, 3)})
        print(json.dumps(out[-1], default=str), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
