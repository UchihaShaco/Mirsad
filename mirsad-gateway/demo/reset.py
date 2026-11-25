"""Forget everything the engine knows about the demo hosts, so the next run starts from "unknown".

Run with the engine stopped (it keeps host decisions in memory):

    docker compose stop engine
    docker compose run --rm --no-deps -v ./demo:/app/demo:ro engine python /app/demo/reset.py
    docker compose start engine
"""

import sqlite3

from scamshield import config

DEMO_HOSTS = ("oasisroastery.com", "uae-trafficfines-pay.com", "go2ae.link", "sandrosetours.com",
              "epost-redelivery-ae.com", "appupdate-cdn-ae.net", "secure-collect-pay.net", "demo.test")


def main() -> None:
    marks = ",".join("?" * len(DEMO_HOSTS))
    with sqlite3.connect(config.DB_PATH) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "verdict_versions" in tables:
            db.execute(f"DELETE FROM verdict_versions WHERE id IN (SELECT id FROM verdicts WHERE host IN ({marks}))",
                       DEMO_HOSTS)
        removed = {}
        for table in ("verdicts", "hosts", "events", "host_changes", "visits", "visit_totals"):
            if table in tables:
                removed[table] = db.execute(f"DELETE FROM {table} WHERE host IN ({marks})", DEMO_HOSTS).rowcount
    print("demo reset:", ", ".join(f"{table} {count}" for table, count in removed.items()))


if __name__ == "__main__":
    main()
