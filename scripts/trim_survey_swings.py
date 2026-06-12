#!/usr/bin/env python3
"""Trim survey clips to a single swing (reddit pool by default).

Uses golfdb swing_segmenter.pt + MediaPipe pose. Caches 105-d pose per reddit clip
under data/pose_features/reddit/ so later runs skip MediaPipe. Progress in
data/trim_progress.json.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
MEDIA_ROOT = ROOT / "data" / "media"
POSE_ROOT = ROOT / "data" / "pose_features"
CATALOG_PATH = ROOT / "data" / "survey_catalog.json"
EXCLUDED_PATH = ROOT / "data" / "excluded_clips.json"
PROGRESS_PATH = ROOT / "data" / "trim_progress.json"
GOLFDB_ROOT = Path(os.environ.get("GOLFDB_REPO_ROOT", Path.home() / "golfdb-master"))

SEGMENT_THRESHOLD = float(os.environ.get("TRIM_SEGMENT_THRESHOLD", "0.4"))
MIN_SWING_FRAMES = int(os.environ.get("TRIM_MIN_SWING_FRAMES", "15"))
MERGE_GAP_FRAMES = int(os.environ.get("TRIM_MERGE_GAP_FRAMES", "25"))
EDGE_FRAME_TOLERANCE = int(os.environ.get("TRIM_EDGE_TOLERANCE", "3"))


def ffprobe_duration(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        text=True,
    ).strip()
    return float(out or 0)


def safe_name(clip_id: str) -> str:
    return str(clip_id).replace("/", "_").replace("\\", "_")[:180]


def ensure_golfdb() -> None:
    if not GOLFDB_ROOT.is_dir():
        raise SystemExit(f"GOLFDB_REPO_ROOT not found: {GOLFDB_ROOT}")
    if str(GOLFDB_ROOT) not in sys.path:
        sys.path.insert(0, str(GOLFDB_ROOT))


def parse_sources(raw: str) -> list[str]:
    sources = [s.strip().lower() for s in raw.split(",") if s.strip()]
    if not sources:
        raise SystemExit("No trim sources specified")
    return sources


@dataclass
class TrimContext:
    segmenter: torch.nn.Module
    mp_pose: object
    device: torch.device
    video_ts_ms: int = 0


def build_context() -> TrimContext:
    ensure_golfdb()
    os.environ.setdefault("PULSE_SERVER", "none")
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")

    from extract_swing_stream import DEVICE, _create_pose_landmarker, load_swing_segmenter  # noqa: PLC0415
    from llm_finetune.lib.swing_detect_cut import (  # noqa: PLC0415
        default_swing_segmenter_path,
        resolve_coach_pose_landmarker,
    )

    pose_path, force_cpu = resolve_coach_pose_landmarker()
    mp_pose, _backend = _create_pose_landmarker(pose_path, force_cpu=force_cpu)
    segmenter = load_swing_segmenter(str(default_swing_segmenter_path()), device=DEVICE)
    return TrimContext(segmenter=segmenter, mp_pose=mp_pose, device=DEVICE)


def pose_npy_path(source: str, clip_id: str) -> Path:
    return POSE_ROOT / source / f"{safe_name(clip_id)}.npy"


def save_pose_npy(
    path: Path,
    features: np.ndarray,
    *,
    video_fps: float,
    source_path: str,
    labels: np.ndarray | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    T = int(features.shape[0])
    payload = {
        "features": np.asarray(features, dtype=np.float32),
        "labels": np.zeros(T, dtype=np.int32) if labels is None else labels,
        "video_fps": float(video_fps),
        "source_path": str(source_path),
    }
    np.save(path, payload, allow_pickle=True)


def load_pose_npy(path: Path, video_path: Path) -> tuple[np.ndarray, float] | None:
    if not path.is_file():
        return None
    try:
        data = np.load(path, allow_pickle=True)
        obj = data[()] if data.ndim == 0 else data
        if not isinstance(obj, dict) or "features" not in obj:
            return None
        stored = str(obj.get("source_path") or "")
        if stored and stored != str(video_path.resolve()):
            return None
        features = np.asarray(obj["features"], dtype=np.float32)
        fps = float(obj.get("video_fps") or 30.0)
        if features.ndim != 2 or features.shape[1] < 105:
            return None
        return features, fps
    except Exception:  # noqa: BLE001
        return None


def extract_pose_probs(
    video_path: Path,
    ctx: TrimContext,
    pose_cache: Path,
) -> tuple[np.ndarray, np.ndarray, float, int]:
    from experimental_vqvae_pipeline.video_bc_ghost_pipeline import _get_container_fps_aligned  # noqa: PLC0415
    from extract_swing_stream import _landmarks_to_vec105, extract_sequence  # noqa: PLC0415
    import mediapipe as mp  # noqa: PLC0415

    cached = load_pose_npy(pose_cache, video_path)
    step = 1

    if cached is not None:
        p105, fps = cached
        print(f"  pose cache hit → {pose_cache.name} (T={p105.shape[0]})")
    else:
        fps = float(_get_container_fps_aligned(str(video_path)))
        if fps <= 0:
            fps = 30.0
        frame_step_ms = max(1, int(round(1000.0 / max(fps, 1e-6))))

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"cannot open video: {video_path}")

        pose_frames: list[np.ndarray] = []
        frame_idx = 0
        ts_start_ms = int(ctx.video_ts_ms)
        try:
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                ts_ms = ts_start_ms + frame_idx * frame_step_ms
                result = ctx.mp_pose.detect_for_video(mp_img, int(ts_ms))
                frame_idx += 1
                vec, pose_ok = _landmarks_to_vec105(result)
                if not pose_ok:
                    vec = pose_frames[-1].copy() if pose_frames else np.zeros(105, dtype=np.float32)
                pose_frames.append(vec)
        finally:
            cap.release()

        if frame_idx > 0:
            ctx.video_ts_ms = ts_start_ms + frame_idx * frame_step_ms

        if len(pose_frames) < MIN_SWING_FRAMES:
            raise RuntimeError(f"video too short after pose extraction: T={len(pose_frames)}")

        p105 = np.asarray(pose_frames, dtype=np.float32)
        save_pose_npy(pose_cache, p105, video_fps=fps, source_path=str(video_path.resolve()))
        print(f"  pose saved → {pose_cache}")

    seq = extract_sequence(p105)
    x = torch.tensor(seq, dtype=torch.float32).unsqueeze(0).to(ctx.device)
    with torch.no_grad():
        probs = torch.sigmoid(ctx.segmenter(x)).squeeze(0).cpu().numpy()

    return p105, probs, fps, step


def detect_segments(pose_105: np.ndarray, probs: np.ndarray) -> list[tuple[int, int]]:
    from swing_detector import swing_segments_from_proba  # noqa: PLC0415

    return swing_segments_from_proba(
        pose_105,
        probs,
        threshold=SEGMENT_THRESHOLD,
        min_swing_frames=MIN_SWING_FRAMES,
        merge_gap=MERGE_GAP_FRAMES,
        refine_motion_peak=True,
        refine_min_len=MIN_SWING_FRAMES,
    )


def pick_segment(
    segments: list[tuple[int, int]],
    pose_105: np.ndarray,
) -> tuple[int, int, int]:
    from experimental_vqvae_pipeline.video_bc_ghost_pipeline import pick_best_swing_segment  # noqa: PLC0415

    if not segments:
        raise RuntimeError("no swing segments detected")
    if len(segments) == 1:
        s, e = segments[0]
        return int(s), int(e), 1
    s, e, _idx, _metrics = pick_best_swing_segment(segments, pose_105)
    return int(s), int(e), len(segments)


def segment_covers_full_clip(s: int, e: int, total_frames: int) -> bool:
    return s <= EDGE_FRAME_TOLERANCE and e >= total_frames - EDGE_FRAME_TOLERANCE


def cut_segment(
    video_path: Path,
    out_path: Path,
    s: int,
    e: int,
    fps: float,
    step: int,
) -> None:
    from experimental_vqvae_pipeline.video_bc_ghost_pipeline import cut_swing_clip_video  # noqa: PLC0415

    ok = cut_swing_clip_video(str(video_path), s, e, fps, step, str(out_path))
    if not ok or not out_path.is_file():
        raise RuntimeError(f"ffmpeg cut failed for frames [{s}, {e})")


def process_video(
    path: Path,
    source: str,
    clip_id: str,
    ctx: TrimContext,
) -> tuple[str, float, float, dict]:
    before = ffprobe_duration(path)
    meta: dict = {"durationBefore": before, "source": source, "id": clip_id}
    pose_cache = pose_npy_path(source, clip_id)

    try:
        pose_105, probs, fps, step = extract_pose_probs(path, ctx, pose_cache)
    except Exception as exc:  # noqa: BLE001
        return "exclude", before, before, {**meta, "reason": "pose_or_segmenter_failed", "error": str(exc)}

    segments = detect_segments(pose_105, probs)
    meta["nSegmentsBefore"] = len(segments)

    if not segments:
        return "exclude", before, before, {**meta, "reason": "no_segments"}

    try:
        s, e, n_before = pick_segment(segments, pose_105)
    except Exception as exc:  # noqa: BLE001
        return "exclude", before, before, {**meta, "reason": "segment_pick_failed", "error": str(exc)}

    meta["swingFrameRange"] = [s, e]
    meta["nSegmentsBeforePick"] = n_before
    T = int(pose_105.shape[0])

    if segment_covers_full_clip(s, e, T) and n_before == 1:
        return "unchanged", before, before, meta

    tmp = path.with_suffix(".trim.tmp.mp4")
    try:
        cut_segment(path, tmp, s, e, fps, step)
        after = ffprobe_duration(tmp)

        if n_before >= 2:
            pose_cache.unlink(missing_ok=True)
            pose2, probs2, _fps2, _step2 = extract_pose_probs(tmp, ctx, pose_cache)
            segments2 = detect_segments(pose2, probs2)
            meta["nSegmentsAfter"] = len(segments2)
            if not segments2:
                tmp.unlink(missing_ok=True)
                return "exclude", before, after, {**meta, "reason": "no_segments_after_trim"}
            if len(segments2) >= 2:
                tmp.unlink(missing_ok=True)
                return "exclude", before, after, {**meta, "reason": "still_multi_swing_after_trim"}

        tmp.replace(path)
        if pose_cache.is_file() and n_before < 2:
            pose_cache.unlink(missing_ok=True)
        after = ffprobe_duration(path)
        meta["durationAfter"] = after
        meta["multiSwingBefore"] = n_before >= 2
        return "trimmed", before, after, meta
    except Exception as exc:  # noqa: BLE001
        tmp.unlink(missing_ok=True)
        return "exclude", before, before, {**meta, "reason": "trim_failed", "error": str(exc)}


def load_progress() -> dict:
    if PROGRESS_PATH.is_file():
        return json.loads(PROGRESS_PATH.read_text())
    return {"sources": [], "completed": [], "excluded": [], "updatedAt": None}


def save_progress(progress: dict) -> None:
    progress["updatedAt"] = datetime.now(timezone.utc).isoformat()
    PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_PATH.write_text(json.dumps(progress, indent=2) + "\n")


def filter_catalog(excluded_keys: set[tuple[str, str]]) -> int:
    if not excluded_keys or not CATALOG_PATH.is_file():
        return 0
    catalog = json.loads(CATALOG_PATH.read_text())
    removed = 0
    for source, clips in list(catalog.get("pools", {}).items()):
        kept = []
        for clip in clips:
            key = (source, str(clip.get("id")))
            if key in excluded_keys:
                removed += 1
                continue
            kept.append(clip)
        catalog["pools"][source] = kept
    catalog["counts"] = {src: len(clips) for src, clips in catalog["pools"].items()}
    catalog["swingTrimmedAt"] = datetime.now(timezone.utc).isoformat()
    catalog["redditTrimOnly"] = True
    CATALOG_PATH.write_text(json.dumps(catalog, indent=2) + "\n")
    return removed


def collect_files(sources: list[str]) -> list[tuple[str, Path, str]]:
    out: list[tuple[str, Path, str]] = []
    for source in sources:
        source_dir = MEDIA_ROOT / source
        if not source_dir.is_dir():
            print(f"WARNING: missing media pool {source_dir}")
            continue
        for path in sorted(source_dir.glob("*.mp4")):
            out.append((source, path, path.stem))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Trim survey clips to a single swing")
    parser.add_argument(
        "--sources",
        default=os.environ.get("TRIM_SOURCES", "reddit"),
        help="Comma-separated pools to trim (default: reddit)",
    )
    parser.add_argument("--no-resume", action="store_true", help="Ignore trim_progress.json")
    args = parser.parse_args()

    sources = parse_sources(args.sources)
    if not MEDIA_ROOT.is_dir():
        raise SystemExit("Missing data/media — run npm run bundle-media first")

    files = collect_files(sources)
    if not files:
        raise SystemExit(f"No mp4 files for sources: {sources}")

    progress = load_progress()
    if args.no_resume:
        progress = {"sources": sources, "completed": [], "excluded": [], "updatedAt": None}
    else:
        progress["sources"] = sources

    done_ids = set(progress.get("completed") or [])
    print(f"Trimming {len(files)} clips from {sources} (resume: {len(done_ids)} already done)")

    ctx = build_context()
    excluded: list[dict] = []
    excluded_keys: set[tuple[str, str]] = set()
    trimmed = unchanged = skipped = 0

    for idx, (source, path, clip_id) in enumerate(files, 1):
        rel = path.relative_to(MEDIA_ROOT)
        key = f"{source}:{clip_id}"
        if key in done_ids:
            skipped += 1
            continue

        print(f"[{idx}/{len(files)}] {rel}")
        status, before, after, meta = process_video(path, source, clip_id, ctx)

        if status == "trimmed":
            trimmed += 1
            print(f"  → trimmed {before:.1f}s → {after:.1f}s (segments={meta.get('nSegmentsBefore')})")
            progress["completed"].append(key)
        elif status == "unchanged":
            unchanged += 1
            print(f"  → unchanged {before:.1f}s")
            progress["completed"].append(key)
        else:
            excluded_keys.add((source, clip_id))
            excluded.append({"path": str(rel), **meta})
            progress.setdefault("excluded", []).append(key)
            print(f"  → EXCLUDE ({meta.get('reason')})")

        save_progress(progress)

    EXCLUDED_PATH.write_text(json.dumps(excluded, indent=2) + "\n")
    removed_from_catalog = filter_catalog(excluded_keys)

    print(
        f"Done. sources={sources} scanned={len(files)} skipped_resume={skipped} "
        f"trimmed={trimmed} unchanged={unchanged} excluded={len(excluded)} "
        f"catalog_removed={removed_from_catalog}"
    )
    print(f"Pose cache: {POSE_ROOT}")
    print(f"Progress: {PROGRESS_PATH}")


if __name__ == "__main__":
    main()
