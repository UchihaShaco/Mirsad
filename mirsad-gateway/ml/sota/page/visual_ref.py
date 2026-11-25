"""Run the official Phishpedia / PhishIntention code and released weights on stored screenshots.

Runs inside the extra env that has torchvision + a CPU-op build of Detectron2 (see README.md):

    nice -n 19 ionice -c 3 ml/sota/page/vendor/env/bin/python -I ml/sota/page/visual_ref.py \
        --method phishpedia --out ml/sota/page/cache/visual__phishpedia.parquet

What is official and what is not
  * Logo detector, Siamese logo matcher, OCR-aided matcher, CRP classifier, 277-brand reference
    logo list, brand -> domain map and every threshold come unchanged from the authors' repos
    (github.com/lindsey98/Phishpedia, github.com/lindsey98/PhishIntention, commits in README.md).
    We call their functions; we do not copy them.
  * PhishIntention's step 4 (CRP locator) clicks through a live site in Chrome. These benchmarks
    never connect to a live site, so it is disabled: a page whose CRP classifier says "not a
    credential page" ends as benign, which is what the official pipeline returns when the locator
    fails. This can only lower PhishIntention's recall.
  * Score for threshold-free metrics: the Siamese similarity of the matched logo when its brand is
    inconsistent with the page domain, else 0 (the quantity the official 0.87 threshold is applied
    to). The verdict is the official one.
  * The brand -> domain pickle is first loaded with a restricted unpickler (plain dict / list /
    str only) and re-written, so the official `pickle.load` only ever sees verified content.
    Checkpoints are loaded by torch>=2.6 `torch.load`, whose default is `weights_only=True`.

Nothing here fetches anything: input is the stored screenshot + the stored URL string + html.txt.
"""

from __future__ import annotations

import argparse
import io
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "ml" / "data"
VENDOR = Path(__file__).resolve().parent / "vendor"
# Large, untrusted downloads live outside the repo's tracked files; both default to git-ignored vendor/.
WEIGHTS = Path(os.environ.get("SOTA_PAGE_WEIGHTS", VENDOR / "weights"))
REFLIST = Path(os.environ.get("SOTA_PAGE_REFLIST", VENDOR / "reflist_expand_targetlist"))  # 277-brand logos
COLS = ["source_id", "url", "label", "source", "brand", "lang", "screenshot_path", "split"]


class _PlainUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module == "builtins" and name in {"dict", "list", "set", "str", "tuple"}:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"refusing {module}.{name}")


def safe_domain_map(src: Path, dst: Path) -> Path:
    if not dst.exists():
        data = _PlainUnpickler(io.BytesIO(src.read_bytes())).load()
        if not isinstance(data, dict):
            raise ValueError("domain map is not a dict")
        clean = {str(k): [str(d) for d in v] for k, v in data.items()}
        dst.write_bytes(pickle.dumps(clean))
    return dst


def link_models(repo: Path, files: dict[str, Path]) -> None:
    models = repo / "models"
    models.mkdir(exist_ok=True)
    for name, target in files.items():
        p = models / name
        if not p.exists():
            p.symlink_to(target)


def offline_tldextract() -> None:
    """The official code calls tldextract.extract(), whose default instance downloads the public suffix
    list on first use. Swap in an instance that only uses the snapshot bundled with the package."""
    from tldextract import tldextract

    tldextract.TLD_EXTRACTOR = tldextract.TLDExtract(suffix_list_urls=())


def screenshot_rows(limit: int | None) -> pd.DataFrame:
    t = pq.read_table(DATA / "processed" / "pages.parquet", columns=COLS + ["has_screenshot"],
                      filters=[("has_screenshot", "==", True)]).to_pandas()
    # The TR-OP rows of the shared LLM sample first (so every method has the same rows), then the rest of
    # TR-OP (the fair test), then Phishpedia's own benchmark, each shuffled so a partial run stays balanced.
    shared = set(pd.read_parquet(Path(__file__).resolve().parent / "cache" / "sample__llm_trop.parquet")["source_id"])
    t["order"] = np.random.default_rng(0).permutation(len(t))
    t["prio"] = np.where(t["source_id"].isin(shared), 0, np.where(t["source"] == "knowphish_tr_op", 1, 2))
    t = t.sort_values(["prio", "order"]).drop(columns=["prio", "order", "has_screenshot"])
    return t.head(limit) if limit else t


class Phishpedia:
    def __init__(self):
        repo = VENDOR / "Phishpedia"
        link_models(repo, {
            "faster_rcnn.yaml": WEIGHTS / "phishpedia" / "faster_rcnn.yaml",
            "rcnn_bet365.pth": WEIGHTS / "phishpedia" / "rcnn_bet365.pth",
            "resnetv2_rgb_new.pth.tar": WEIGHTS / "phishpedia" / "resnetv2_rgb_new.pth.tar",
            "expand_targetlist": REFLIST,
            "domain_map.pkl": safe_domain_map(DATA / "raw_pages" / "phishpedia" / "domain_map.pkl",
                                              WEIGHTS / "domain_map.safe.pkl"),
        })
        sys.path.insert(0, str(repo))
        from configs import load_config  # official
        from logo_matching import check_domain_brand_inconsistency
        from logo_recog import pred_rcnn

        self.pred_rcnn, self.check = pred_rcnn, check_domain_brand_inconsistency
        (self.ele, self.thr, self.siamese, self.feats, self.files, self.domain_map) = load_config()
        self.feats = np.asarray(self.feats)  # a list on the first (caching) run, which the matcher rejects

    def __call__(self, url: str, shot: str, html: str) -> dict:
        boxes = self.pred_rcnn(im=shot, predictor=self.ele)
        if boxes is None or len(boxes) == 0:
            return {"pred": 0, "score": 0.0, "target": None, "conf": None, "n_logos": 0}
        boxes = boxes.detach().cpu().numpy()
        # threshold 0 returns the top-1 brand of the top logo whenever its domain is inconsistent;
        # with the official topk=1 and no resolution alignment this equals the 0.87 decision.
        target, _, _, conf = self.check(logo_boxes=boxes, domain_map_path=self.domain_map, model=self.siamese,
                                        logo_feat_list=self.feats, file_name_list=self.files, url=url,
                                        shot_path=shot, similarity_threshold=0.0, topk=1)
        conf = float(conf) if conf is not None else None
        score = conf if (target is not None and conf is not None) else 0.0
        return {"pred": int(score >= self.thr), "score": score, "target": target if score >= self.thr else None,
                "top_brand_inconsistent": target, "conf": conf, "n_logos": int(len(boxes))}


class PhishIntention:
    """Steps 1-3 of the official pipeline (phishintention/pipeline.py: layout detector -> OCR-aided Siamese
    logo matching + domain check -> HTML heuristic, then the screenshot CRP classifier). The official
    modules are called directly so that the Selenium-based CRP locator (step 4) is never imported."""

    def __init__(self):
        repo = VENDOR / "PhishIntention"
        w = WEIGHTS / "phishintention"
        link_models(repo, {
            "layout_detector.pth": w / "layout_detector.pth",
            "crp_classifier.pth.tar": w / "crp_classifier.pth.tar",
            "ocr_pretrained.pth.tar": w / "ocr_pretrained.pth.tar",
            "ocr_siamese.pth.tar": w / "ocr_siamese.pth.tar",
            "crp_locator.pth": w / "crp_locator.pth",  # built by the official loader, unused here
            "expand_targetlist": REFLIST,
            "domain_map.pkl": safe_domain_map(DATA / "raw_pages" / "phishpedia" / "domain_map.pkl",
                                              WEIGHTS / "domain_map.safe.pkl"),
        })
        os.chdir(repo)  # the official config resolves models/ and configs/ against the working directory
        sys.path.insert(0, str(repo / "src"))
        from phishintention.config import load_config  # official
        from phishintention.modules.awl_detector import find_element_type, pred_rcnn
        from phishintention.modules.crp_classifier import credential_classifier_mixed, html_heuristic
        from phishintention.modules.logo_matching import check_domain_brand_inconsistency

        self.pred_rcnn, self.find, self.check = pred_rcnn, find_element_type, check_domain_brand_inconsistency
        self.heuristic, self.crp_cls = html_heuristic, credential_classifier_mixed
        (self.awl, self.crp_model, _, self.siamese, self.ocr, self.thr, self.feats, self.files,
         self.domain_map) = load_config()

    def __call__(self, url: str, shot: str, html: str) -> dict:
        out = {"pred": 0, "score": 0.0, "target": None, "conf": None, "n_logos": 0, "crp": None}
        boxes, classes, _ = self.pred_rcnn(im=shot, predictor=self.awl)
        if boxes is None or len(boxes) == 0:
            return out
        boxes, classes = boxes.numpy(), classes.numpy()
        logos, _ = self.find(boxes, classes, bbox_type="logo")
        out["n_logos"] = 0 if logos is None else int(len(logos))
        if logos is None or len(logos) == 0:
            return out
        target, _, _, conf = self.check(logo_boxes=np.asarray(logos).reshape(-1, 4), domain_map_path=self.domain_map,
                                        model=self.siamese, ocr_model=self.ocr, logo_feat_list=self.feats,
                                        file_name_list=self.files, url=url, shot_path=shot, ts=self.thr)
        out["conf"] = float(conf) if conf is not None else None
        if target is None:
            return out
        crp = self.heuristic(html)
        if crp == 1:  # official: HTML heuristic says non-CRP -> ask the screenshot classifier
            crp = self.crp_cls(img=shot, coords=boxes, types=classes, model=self.crp_model)
        out["crp"] = int(crp == 0)  # official convention: 0 = credential-requiring page
        if crp == 0:
            out.update(pred=1, score=float(conf), target=target)
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", choices=["phishpedia", "phishintention"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--flush", type=int, default=250)
    a = ap.parse_args()
    import torch

    torch.set_num_threads(4)
    offline_tldextract()
    out = Path(a.out).resolve()  # PhishIntention's loader changes the working directory
    done = pd.read_parquet(out) if out.exists() else pd.DataFrame(columns=["source_id"])
    rows = screenshot_rows(a.limit)
    rows = rows[~rows["source_id"].isin(set(done["source_id"]))]
    det = Phishpedia() if a.method == "phishpedia" else PhishIntention()
    print(f"{a.method}: {len(rows)} rows to do, device={'cuda' if torch.cuda.is_available() else 'cpu'}",
          flush=True)
    buf = []
    for i, r in enumerate(rows.itertuples(index=False), 1):
        shot = str(DATA / r.screenshot_path)
        html = shot[: -len("shot.png")] + "html.txt"
        t0 = time.perf_counter()
        try:
            res = det(r.url or "", shot, html)
            err = None
        except Exception as e:  # noqa: BLE001 - one unreadable screenshot must not stop the run
            res, err = {"pred": 0, "score": 0.0, "target": None, "conf": None, "n_logos": 0}, repr(e)[:200]
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        res.update(source_id=r.source_id, seconds=time.perf_counter() - t0, error=err)
        buf.append(res)
        if len(buf) >= a.flush or i == len(rows):
            done = pd.concat([done, pd.DataFrame(buf)], ignore_index=True) if len(done) else pd.DataFrame(buf)
            done.to_parquet(out)
            buf = []
            print(f"{i}/{len(rows)} done, median {done['seconds'].median():.3f} s/page", flush=True)


if __name__ == "__main__":
    main()
