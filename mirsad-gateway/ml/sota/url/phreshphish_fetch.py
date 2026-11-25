"""Download the PhreshPhish benchmark definitions (lists of sample sha256) and the sha256 / url / label of the
official train and test splits, without the HTML: only those column chunks of each parquet file are read over
HTTP range requests. Nothing here contacts the URLs themselves.

    nice -n 19 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.phreshphish_fetch
"""

from __future__ import annotations

import pandas as pd
import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem, snapshot_download

from ml.sota.url.data import WORK
from ml.url.train import log

REPO = "phreshphish/phreshphish"
BENCH_DIR = WORK / "phreshphish_benchmark"


def main() -> None:
    snapshot_download(REPO, repo_type="dataset", allow_patterns=["benchmark/*"], local_dir=BENCH_DIR, max_workers=8)
    fs = HfFileSystem()
    for split in ("train", "test"):
        parts = []
        for path in sorted(fs.glob(f"datasets/{REPO}/data/{split}-*.parquet")):
            with fs.open(path, block_size=2**20) as f:
                parts.append(pq.read_table(f, columns=["sha256", "url", "label"]).to_pandas())
            log(f"{path}: {len(parts[-1]):,} rows")
        pd.concat(parts, ignore_index=True).to_parquet(WORK / f"phreshphish_official_{split}.parquet")


if __name__ == "__main__":
    main()
