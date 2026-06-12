#!/usr/bin/env python3
"""Curate numbered Reddit survey clips with Qwen2.5-VL (vision LLM).

Reads ``data/reddit_numbered/{n}.mp4`` + manifest.json, sends every frame to the
model, and writes curated outputs under ``data/reddit_numbered_vl/`` without
modifying originals.

Requires CUDA + golfdb-master deps (see GOLFDB_REPO_ROOT).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GOLFDB_ROOT = Path(os.environ.get("GOLFDB_REPO_ROOT", Path.home() / "golfdb-master"))

def _resolve_dirs(args: argparse.Namespace) -> None:
    global INPUT_DIR, MANIFEST_PATH, OUT_ROOT, ACCEPTED_DIR, REPORTS_DIR, PROGRESS_PATH, CURATED_MANIFEST
    INPUT_DIR = Path(args.input_dir).resolve() if args.input_dir else ROOT / "data" / "reddit_numbered"
    MANIFEST_PATH = INPUT_DIR / "manifest.json"
    OUT_ROOT = Path(args.output_dir).resolve() if args.output_dir else ROOT / "data" / "reddit_numbered_vl"
    ACCEPTED_DIR = OUT_ROOT / "accepted"
    REPORTS_DIR = OUT_ROOT / "reports"
    PROGRESS_PATH = OUT_ROOT / "progress.json"
    CURATED_MANIFEST = OUT_ROOT / "manifest_curated.json"

LOG = logging.getLogger("vl_curate")

SYSTEM_PROMPT = """You are a golf swing video curator for a coach survey dataset.

You receive EVERY frame of a short amateur golf clip, in order (frame 0, 1, 2, ...).

Rules:
- A FULL swing = meaningful address/setup through finish/follow-through with a real strike or full practice motion.
  Half swings, chips, putts, waggles-only, ball pickup, walking, or setup with no swing DO NOT count.
- If the clip has NO full swing, decision must be "reject".
- If multiple FULL swings appear, list each as a segment with frame ranges.
  When choosing which segment to keep, prefer DOWN-THE-LINE (DTL) camera:
  golfer mostly in profile, chest/torso visible from the side, club path toward/away from camera.
  Prefer DTL over face-on. Among DTL full swings, pick the clearest complete swing.
- Frame indices are 0-based inclusive on both ends in your JSON.
- Respond with ONLY valid JSON (no markdown fences):
{
  "decision": "accept" | "reject",
  "reject_reason": string | null,
  "total_frames": <int>,
  "segments": [
    {
      "start_frame": <int>,
      "end_frame": <int>,
      "is_full_swing": <bool>,
      "camera_angle": "down_the_line" | "face_on" | "other",
      "notes": "<short>"
    }
  ],
  "selected_segment_index": <int | null>,
  "padding_frames": 4,
  "start_ratio": <float | null>,
  "end_ratio": <float | null>
}"""


def ensure_golfdb() -> None:
    if not GOLFDB_ROOT.is_dir():
        raise SystemExit(f"GOLFDB_REPO_ROOT not found: {GOLFDB_ROOT}")
    if str(GOLFDB_ROOT) not in sys.path:
        sys.path.insert(0, str(GOLFDB_ROOT))


def load_manifest() -> list[dict[str, Any]]:
    if not MANIFEST_PATH.is_file():
        raise SystemExit(f"Missing {MANIFEST_PATH}")
    data = json.loads(MANIFEST_PATH.read_text())
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("clips"), list):
        return data["clips"]
    raise SystemExit(f"Invalid manifest format: {MANIFEST_PATH}")


def load_progress() -> dict[str, Any]:
    if PROGRESS_PATH.is_file():
        return json.loads(PROGRESS_PATH.read_text())
    return {"completed": {}, "updatedAt": None}


def save_progress(progress: dict[str, Any]) -> None:
    progress["updatedAt"] = datetime.now(timezone.utc).isoformat()
    PROGRESS_PATH.write_text(json.dumps(progress, indent=2) + "\n")


def build_messages(
    video_path: Path,
    *,
    max_frame_edge: int,
    max_frames: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    from llm_finetune.lib.coach_inference import _build_user_content  # noqa: PLC0415
    from llm_finetune.lib.frame_extract import probe_video  # noqa: PLC0415

    info = probe_video(video_path)
    total = int(info["total_frames"])
    use_all = total <= int(max_frames)
    content, visual_desc, meta = _build_user_content(
        video_path,
        frame_paths=None,
        use_full_video=True,
        max_frame_edge=max_frame_edge,
        extract_mode="all" if use_all else "adaptive",
        adaptive_max_frames=int(max_frames) if not use_all else int(max_frames),
    )
    frame_note = (
        "Frame indices refer to the full video (0..{n}-1)."
        if use_all
        else (
            f"Frames shown are a motion-weighted subsample of {total} source frames. "
            "Return segment boundaries as start_ratio and end_ratio (0.0-1.0 of full clip duration) "
            "in addition to frame indices on the subsample."
        )
    ).format(n=total)
    content[-1]["text"] = (
        f"Curate this numbered survey clip for a single full golf swing.\n\n"
        f"{visual_desc}\n\n"
        f"{frame_note}\n\n"
        "Identify all swing segments. Reject if no full swing. "
        "If multiple full swings, select the best down-the-line full swing segment.\n"
        "Return only the JSON schema from the system prompt."
    )
    meta["subsampled"] = not use_all
    meta["source_total_frames"] = total
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]
    meta["visual_desc"] = visual_desc
    return messages, meta


def parse_curation(text: str) -> dict[str, Any]:
    from llm_finetune.lib.json_parse import parse_json_from_llm  # noqa: PLC0415

    obj = parse_json_from_llm(text)
    if not isinstance(obj, dict):
        raise ValueError("VL output must be a JSON object")
    decision = str(obj.get("decision", "")).lower()
    if decision not in ("accept", "reject"):
        raise ValueError(f"invalid decision: {decision!r}")
    return obj


def pick_segment(obj: dict[str, Any]) -> dict[str, Any] | None:
    segments = obj.get("segments") or []
    if not isinstance(segments, list):
        return None
    idx = obj.get("selected_segment_index")
    if idx is not None and 0 <= int(idx) < len(segments):
        seg = segments[int(idx)]
        if seg.get("is_full_swing", True):
            return seg
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        if not seg.get("is_full_swing"):
            continue
        if str(seg.get("camera_angle", "")).lower() in ("down_the_line", "dtl"):
            return seg
    for seg in segments:
        if isinstance(seg, dict) and seg.get("is_full_swing"):
            return seg
    return None


def cut_segment(
    src: Path,
    dst: Path,
    *,
    start_frame: int,
    end_frame: int,
    fps: float,
    total_frames: int,
    pad: int,
) -> None:
    s = max(0, int(start_frame) - int(pad))
    e = min(int(total_frames) - 1, int(end_frame) + int(pad))
    start_t = s / fps
    duration = (e + 1) / fps - start_t
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start_t:.4f}",
            "-i",
            str(src),
            "-t",
            f"{duration:.4f}",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-preset",
            "fast",
            "-an",
            "-movflags",
            "+faststart",
            str(dst),
        ],
        check=True,
        capture_output=True,
    )


def copy_as_is(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-c", "copy", str(dst)], check=True, capture_output=True)


def resolve_cut_range(
    parsed: dict[str, Any],
    seg: dict[str, Any],
    *,
    total_frames: int,
    subsampled: bool,
) -> tuple[int, int]:
    if subsampled:
        sr = parsed.get("start_ratio")
        er = parsed.get("end_ratio")
        if sr is not None and er is not None:
            s = int(round(float(sr) * (total_frames - 1)))
            e = int(round(float(er) * (total_frames - 1)))
            return max(0, s), min(total_frames - 1, max(s, e))
    return int(seg["start_frame"]), int(seg["end_frame"])


def curate_one(
    entry: dict[str, Any],
    coach: Any,
    *,
    max_frame_edge: int,
    max_frames: int,
    dry_run: bool,
) -> dict[str, Any]:
    from llm_finetune.lib.frame_extract import cleanup_frame_paths, probe_video  # noqa: PLC0415

    number = int(entry["number"])
    src = INPUT_DIR / f"{number}.mp4"
    if not src.is_file():
        raise FileNotFoundError(src)

    info = probe_video(src)
    messages, extract_meta = build_messages(
        src, max_frame_edge=max_frame_edge, max_frames=max_frames
    )
    frame_paths = [Path(p) for p in extract_meta.get("extracted_frame_paths", [])]

    try:
        result = coach.generate_messages(messages)
        parsed = parse_curation(result.text)
    finally:
        if frame_paths:
            cleanup_frame_paths(frame_paths)

    report: dict[str, Any] = {
        "number": number,
        "id": entry.get("id"),
        "sourceFile": entry.get("sourceFile"),
        "inputVideo": str(src.relative_to(ROOT)),
        "probe": info,
        "vl_raw": result.text,
        "vl_parsed": parsed,
        "vl_elapsed_s": round(result.elapsed_s, 2),
        "extract_meta": {k: v for k, v in extract_meta.items() if k != "extracted_frame_paths"},
    }

    decision = str(parsed.get("decision", "")).lower()
    out_mp4 = ACCEPTED_DIR / f"{number}.mp4"

    if decision == "reject":
        report["outcome"] = "rejected"
        report["reject_reason"] = parsed.get("reject_reason") or "no_full_swing"
        return report

    seg = pick_segment(parsed)
    if seg is None:
        report["outcome"] = "rejected"
        report["reject_reason"] = "accept_decision_but_no_valid_segment"
        parsed["decision"] = "reject"
        return report

    pad = int(parsed.get("padding_frames") or 4)
    total = int(info["total_frames"])
    start_f, end_f = resolve_cut_range(
        parsed,
        seg,
        total_frames=total,
        subsampled=bool(extract_meta.get("subsampled")),
    )
    fps = float(info["fps"])

    report["selected_segment"] = seg
    report["cut_frames"] = [start_f, end_f]
    report["padding_frames"] = pad

    if dry_run:
        report["outcome"] = "accept_dry_run"
        return report

    span = end_f - start_f + 1
    if span >= total - 2:
        copy_as_is(src, out_mp4)
        report["outcome"] = "accepted_copy"
    else:
        cut_segment(
            src,
            out_mp4,
            start_frame=start_f,
            end_frame=end_f,
            fps=fps,
            total_frames=total,
            pad=pad,
        )
        report["outcome"] = "accepted_cut"

    return report


def write_curated_manifest(progress: dict[str, Any], manifest_in: list[dict[str, Any]]) -> None:
    by_num = {int(e["number"]): e for e in manifest_in}
    rows = []
    for num_str, report in sorted(progress.get("completed", {}).items(), key=lambda x: int(x[0])):
        num = int(num_str)
        entry = by_num.get(num, {})
        row = {
            "number": num,
            "id": entry.get("id"),
            "originalSource": entry.get("sourceFile"),
            "outcome": report.get("outcome"),
            "reject_reason": report.get("reject_reason"),
            "acceptedVideo": (
                str((ACCEPTED_DIR / f"{num}.mp4").relative_to(ROOT))
                if report.get("outcome", "").startswith("accept")
                else None
            ),
            "report": str((REPORTS_DIR / f"{num}.json").relative_to(ROOT)),
        }
        rows.append(row)
    payload = {
        "curatedAt": datetime.now(timezone.utc).isoformat(),
        "inputDir": str(INPUT_DIR.relative_to(ROOT)),
        "acceptedDir": str(ACCEPTED_DIR.relative_to(ROOT)),
        "model": os.environ.get("VL_CURATE_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct"),
        "clips": rows,
        "acceptedCount": sum(1 for r in rows if r.get("acceptedVideo")),
        "rejectedCount": sum(1 for r in rows if not r.get("acceptedVideo")),
    }
    CURATED_MANIFEST.write_text(json.dumps(payload, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="VL-curate numbered Reddit clips (Qwen2.5-VL).")
    parser.add_argument(
        "--input-dir",
        default="",
        help="Folder with {n}.mp4 + manifest.json (default: data/reddit_numbered)",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Output root for accepted/, reports/, manifest_curated.json",
    )
    parser.add_argument("--max-frame-edge", type=int, default=int(os.environ.get("VL_MAX_FRAME_EDGE", "384")))
    parser.add_argument(
        "--max-frames",
        type=int,
        default=int(os.environ.get("VL_CURATE_MAX_FRAMES", "96")),
        help="Use all frames up to this count; longer clips use motion-adaptive subsample",
    )
    parser.add_argument("--only", type=str, default="", help="Comma-separated clip numbers to process")
    parser.add_argument("--dry-run", action="store_true", help="VL inference only, no ffmpeg output")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--fresh", action="store_true", help="Ignore existing progress.json")
    args = parser.parse_args()
    _resolve_dirs(args)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    os.environ.setdefault("PULSE_SERVER", "none")
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    ensure_golfdb()
    from llm_finetune.config import QWEN_VL_BASE  # noqa: PLC0415
    from llm_finetune.lib.vl_model import QwenVLCoach  # noqa: PLC0415

    manifest = load_manifest()
    only = {int(x.strip()) for x in args.only.split(",") if x.strip()}
    if args.fresh and PROGRESS_PATH.is_file():
        PROGRESS_PATH.unlink()
    progress = load_progress()
    completed: dict[str, Any] = progress.setdefault("completed", {})

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ACCEPTED_DIR.mkdir(parents=True, exist_ok=True)

    model_name = os.environ.get("VL_CURATE_MODEL", QWEN_VL_BASE)
    LOG.info("Loading vision LLM %s (4-bit CUDA; not vllm serve)", model_name)
    coach = QwenVLCoach.from_checkpoints(model_name, max_new_tokens=2048, temperature=0.1)

    processed = 0
    try:
        for entry in manifest:
            number = int(entry["number"])
            if only and number not in only:
                continue
            prev = completed.get(str(number), {})
            if str(number) in completed and not only and not args.dry_run:
                if prev.get("outcome") not in (None, "accept_dry_run"):
                    LOG.info("skip %d (already curated: %s)", number, prev.get("outcome"))
                    continue

            LOG.info("=== clip %d / %s ===", number, entry.get("id", "")[:48])
            try:
                report = curate_one(
                    entry,
                    coach,
                    max_frame_edge=args.max_frame_edge,
                    max_frames=args.max_frames,
                    dry_run=args.dry_run,
                )
            except Exception as exc:  # noqa: BLE001
                LOG.exception("clip %d failed: %s", number, exc)
                from llm_finetune.lib.vl_model import release_vram  # noqa: PLC0415

                release_vram()
                report = {
                    "number": number,
                    "id": entry.get("id"),
                    "outcome": "error",
                    "reject_reason": str(exc),
                }

            completed[str(number)] = {
                "outcome": report.get("outcome"),
                "reject_reason": report.get("reject_reason"),
            }
            (REPORTS_DIR / f"{number}.json").write_text(json.dumps(report, indent=2) + "\n")
            save_progress(progress)
            write_curated_manifest(progress, manifest)
            processed += 1

            if args.limit and processed >= args.limit:
                break
    finally:
        coach.unload()

    LOG.info("Done. processed=%d accepted_dir=%s", processed, ACCEPTED_DIR)


if __name__ == "__main__":
    main()
