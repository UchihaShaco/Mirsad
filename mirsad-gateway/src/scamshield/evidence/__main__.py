"""Build one evidence pack in its own process:
`python -m scamshield.evidence <verdict.json> <out_dir> [<earlier case folder to reuse artefacts from>]`.

The engine's evidence worker runs this under `nice` so a browser crash or a slow PDF never touches the
process that answers users. Prints `{"case_ref", "zip", "thumbnail"}` as JSON on success.
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
from pathlib import Path

from ..schemas import Verdict
from .pack import build_pack, load_artefacts

THUMB_WIDTH = 240


def thumbnail(png: Path, dest: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return False
    with Image.open(png) as img:
        img = img.convert("RGB")
        height = min(img.height, int(img.width * 1.6))
        img = img.crop((0, 0, img.width, height))
        img.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 2))
        buffer = io.BytesIO()
        img.save(buffer, "JPEG", quality=78)
    dest.write_bytes(buffer.getvalue())
    return True


def main() -> int:
    verdict = Verdict.model_validate_json(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    reuse = load_artefacts(Path(sys.argv[3])) if len(sys.argv) > 3 else None
    path = asyncio.run(build_pack(verdict, out_dir, extract=True, reuse=reuse))
    case_ref = path.stem
    folder = out_dir / case_ref
    thumb = out_dir / f"{case_ref}.thumb.jpg"
    source = next((folder / name for name in ("screenshot.png", "screenshot_engine.png") if (folder / name).is_file()), None)
    made = bool(source) and thumbnail(source, thumb)
    print(json.dumps({"case_ref": case_ref, "zip": str(path), "thumbnail": str(thumb) if made else None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
