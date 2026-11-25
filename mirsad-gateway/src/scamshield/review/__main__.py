"""Run a second-opinion review from the command line and print each step as it happens.

    python -m scamshield.review <verdict-id | url> [--rules] [--seconds 60] [--json]

A verdict id is fetched from the engine API (`SCAMSHIELD_ENGINE_URL`); a URL is first checked
through the engine (`POST /v1/check`). If the engine is unreachable, a URL is reviewed as a bare
blocked verdict so the demo still runs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

import httpx

from scamshield import config
from scamshield.schemas import Decision, ReviewStep, Verdict

from .agent import Budget, review_verdict
from .sources import host_of, registered_domain

_MARK = {True: "BLOCK+", False: "LEGIT+", None: "  ·   "}


async def load_verdict(target: str) -> Verdict:
    is_url = "://" in target or "." in target  # verdict ids are bare hex
    async with httpx.AsyncClient(base_url=config.ENGINE_URL, timeout=90) as client:
        try:
            if is_url:
                url = target if "://" in target else f"https://{target}"
                checked = await client.post("/v1/check", json={"url": url, "depth": "page"})
                checked.raise_for_status()
                target = checked.json()["id"]
            response = await client.get(f"/v1/verdicts/{target}")
            response.raise_for_status()
            return Verdict.model_validate(response.json())
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            if not is_url:
                raise SystemExit(f"could not load verdict {target} from {config.ENGINE_URL}: {exc}") from exc
            print(f"! engine at {config.ENGINE_URL} unavailable ({exc.__class__.__name__}); "
                  "reviewing the URL as a bare blocked verdict", file=sys.stderr)
            host = host_of(url)
            return Verdict(url=url, host=host, registered_domain=registered_domain(host), decision=Decision.BLOCK,
                           risk_score=float(config.BLOCK_THRESHOLD))


def print_step(step: ReviewStep, started: float) -> None:
    print(f"{time.monotonic() - started:6.1f}s  {_MARK[step.supports_block]}  {step.tool:<24} {step.finding}",
          flush=True)


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scamshield.review", description=__doc__.split("\n")[0])
    parser.add_argument("target", help="verdict id or URL")
    parser.add_argument("--rules", action="store_true", help="use the rule-based checklist, no LLM")
    parser.add_argument("--seconds", type=float, default=None, help="wall-clock budget")
    parser.add_argument("--json", action="store_true", help="print the ReviewResult as JSON at the end")
    args = parser.parse_args(argv)

    verdict = await load_verdict(args.target)
    print(f"Reviewing {verdict.url}  (verdict {verdict.id[:12]}, {verdict.decision.value}, "
          f"risk {verdict.risk_score:.0f}, {len(verdict.reasons)} reasons)")
    if verdict.decision is not Decision.BLOCK:
        print(f"note: this verdict is '{verdict.decision.value}', not a block; reviewing anyway")
    budget = Budget()
    if args.seconds:
        budget.max_seconds = args.seconds
    started = time.monotonic()
    kwargs = {"judge": None} if args.rules else {}
    result = await review_verdict(verdict, budget=budget, on_step=lambda s: print_step(s, started), **kwargs)
    print(f"\n=> {result.outcome.value.upper()}  (recommend {result.decision.value}, confidence "
          f"{result.confidence:.2f}, {result.model}, {time.monotonic() - started:.1f} s)")
    print(f"EN: {result.summary_en}\nAR: {result.summary_ar}")
    if args.json:
        print(json.dumps(result.model_dump(mode="json"), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
