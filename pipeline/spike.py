"""
Phase 0 spike: does a real MLS photo set yield usable depth?

This is the one genuinely uncertain part of the project, so it runs before any
product code is trusted. Everything downstream - the 2.5D shells that give the
tour its parallax - depends on monocular depth surviving the way listing photos
are actually produced: wide-angle, heavily tone-mapped, blown-out windows.

Uses MoGe-2 (MIT licensed, commercially usable checkpoints) to predict metric
depth and camera intrinsics per photo, then writes three things per image:

  * a depth preview PNG - eyeball it, look at window and mirror edges
  * a coloured point cloud PLY - open it, orbit it, find where it tears
  * an entry in report.json - including the tear-risk score that becomes
                                   `parallaxBudget` in the property schema

Run on Colab's free T4 (see spike.ipynb) or any CUDA box:

    python pipeline/spike.py --photos photos/123-main-st --out pipeline/out

The go/no-go is a judgement call made by looking at the point clouds, not by a
number this script prints. The number only ranks which photos are worst.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG"}

# Photos wider than this are downscaled before inference. MoGe-2 is resolution
# tolerant and full-size MLS photos mostly cost VRAM without adding detail.
MAX_EDGE_PX = 1400

# Relative disparity curvature above which a pixel counts as sitting on a real
# depth discontinuity - an edge where a 2.5D shell will visibly stretch.
# Matches uStretchLimit in src/lib/render/depth-shell.ts; the two must agree, or
# the budgets this reports will not describe what the renderer actually does.
DISCONTINUITY_THRESHOLD = 0.06

# Parallax budget in metres, interpolated between these by tear risk. The low
# end still reads as 3D; the high end is about where a clean room can go.
PARALLAX_MIN_M = 0.12
PARALLAX_MAX_M = 0.55


def find_images(folder: Path) -> list[Path]:
    files = sorted(p for p in folder.iterdir() if p.suffix in IMAGE_SUFFIXES)
    if not files:
        raise SystemExit(f"No images found in {folder}")
    return files


def tear_risk(depth, mask=None) -> float:
    """
    Fraction of pixels sitting on a depth discontinuity, 0..1.

    A 2.5D shell is a single displaced grid: it can only stretch across a depth
    jump, never reveal what is behind it. So the density of those jumps predicts
    how far the camera can move before the illusion breaks, which is exactly
    what the viewer needs to clamp its parallax budget to.

    Measured as the *curvature* of inverse depth, not its gradient. Disparity
    is affine across the image for any plane regardless of viewing angle, so its
    second difference vanishes on every flat surface and spikes only where the
    surface genuinely breaks. A plain gradient would flag a floor seen edge-on
    as though it were an object silhouette, which is the same mistake the
    renderer would then make.
    """
    import numpy as np

    d = np.asarray(depth, dtype=np.float32)
    valid = np.isfinite(d) & (d > 1e-6)
    if mask is not None:
        valid &= np.asarray(mask, dtype=bool)
    if valid.sum() < 100:
        return 1.0

    disparity = np.zeros_like(d)
    disparity[valid] = 1.0 / d[valid]
    hi = np.percentile(disparity[valid], 99)
    if hi <= 0:
        return 1.0
    disparity = np.clip(disparity / hi, 1e-4, 1.0)

    lap_x = np.abs(np.diff(disparity, n=2, axis=1, prepend=0, append=0))
    lap_y = np.abs(np.diff(disparity, n=2, axis=0, prepend=0, append=0))
    curvature = np.maximum(lap_x, lap_y) / disparity
    return float((curvature[valid] > DISCONTINUITY_THRESHOLD).mean())


def parallax_budget(risk: float) -> float:
    """Map tear risk onto the metres of camera drift the viewer will allow."""
    return round(PARALLAX_MAX_M + (PARALLAX_MIN_M - PARALLAX_MAX_M) * min(risk / 0.25, 1.0), 3)


def save_depth_preview(depth, mask, path: Path) -> None:
    import numpy as np
    from PIL import Image

    d = np.asarray(depth, dtype=np.float32)
    valid = np.isfinite(d) & (d > 1e-6)
    if mask is not None:
        valid &= np.asarray(mask, dtype=bool)
    if valid.sum() == 0:
        Image.new("L", (d.shape[1], d.shape[0])).save(path)
        return

    # Near = bright. Percentile clipping keeps one blown-out window from
    # flattening the entire room into the bottom of the range.
    disparity = np.where(valid, 1.0 / np.maximum(d, 1e-6), 0.0)
    lo, hi = np.percentile(disparity[valid], [2, 98])
    norm = np.clip((disparity - lo) / max(hi - lo, 1e-6), 0, 1)
    Image.fromarray((norm * 255).astype(np.uint8)).save(path)


def save_ply(points, colors, mask, path: Path, stride: int = 2) -> int:
    """Minimal ASCII PLY so the clouds open anywhere without extra deps."""
    import numpy as np

    pts = np.asarray(points, dtype=np.float32)[::stride, ::stride].reshape(-1, 3)
    cols = np.asarray(colors, dtype=np.uint8)[::stride, ::stride].reshape(-1, 3)
    keep = np.isfinite(pts).all(axis=1)
    if mask is not None:
        keep &= np.asarray(mask, dtype=bool)[::stride, ::stride].reshape(-1)
    pts, cols = pts[keep], cols[keep]

    with path.open("w") as f:
        f.write("ply\nformat ascii 1.0\n")
        f.write(f"element vertex {len(pts)}\n")
        f.write("property float x\nproperty float y\nproperty float z\n")
        f.write("property uchar red\nproperty uchar green\nproperty uchar blue\n")
        f.write("end_header\n")
        for (x, y, z), (r, g, b) in zip(pts, cols):
            f.write(f"{x:.4f} {y:.4f} {z:.4f} {r} {g} {b}\n")
    return len(pts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--photos", type=Path, required=True, help="folder of listing photos")
    ap.add_argument("--out", type=Path, default=Path("pipeline/out"))
    ap.add_argument("--model", default="Ruicheng/moge-2-vitl-normal")
    ap.add_argument("--limit", type=int, default=0, help="only process the first N photos")
    ap.add_argument("--stride", type=int, default=2, help="point cloud subsampling")
    args = ap.parse_args()

    try:
        import numpy as np
        import torch
        from PIL import Image
    except ImportError as e:
        print(f"Missing dependency: {e}\nSee pipeline/README.md", file=sys.stderr)
        return 1

    try:
        from moge.model.v2 import MoGeModel
    except ImportError:
        print(
            "MoGe not installed. Run:\n"
            "  pip install git+https://github.com/microsoft/MoGe.git",
            file=sys.stderr,
        )
        return 1

    images = find_images(args.photos)
    if args.limit:
        images = images[: args.limit]

    out = args.out
    (out / "depth").mkdir(parents=True, exist_ok=True)
    (out / "cloud").mkdir(parents=True, exist_ok=True)

    device = (
        "cuda" if torch.cuda.is_available()
        else "mps" if torch.backends.mps.is_available()
        else "cpu"
    )
    print(f"device={device}  photos={len(images)}  model={args.model}")
    if device == "cpu":
        print("  (CPU inference is slow  Colab's free T4 is the intended target)")

    model = MoGeModel.from_pretrained(args.model).to(device).eval()

    report = []
    for i, path in enumerate(images, 1):
        image = Image.open(path).convert("RGB")
        if max(image.size) > MAX_EDGE_PX:
            scale = MAX_EDGE_PX / max(image.size)
            image = image.resize(
                (round(image.width * scale), round(image.height * scale)),
                Image.LANCZOS,
            )
        rgb = np.asarray(image)

        tensor = torch.tensor(rgb / 255.0, dtype=torch.float32, device=device)
        tensor = tensor.permute(2, 0, 1)
        with torch.no_grad():
            out_dict = model.infer(tensor)

        depth = out_dict["depth"].cpu().numpy()
        points = out_dict["points"].cpu().numpy()
        mask = out_dict["mask"].cpu().numpy() if "mask" in out_dict else None
        intrinsics = out_dict["intrinsics"].cpu().numpy()

        # MoGe returns normalised intrinsics; recover the horizontal FOV the
        # viewer needs to size each photo's shell correctly.
        fov_deg = float(np.degrees(2 * np.arctan(0.5 / max(intrinsics[0, 0], 1e-6))))

        risk = tear_risk(depth, mask)
        save_depth_preview(depth, mask, out / "depth" / f"{path.stem}.png")
        n_points = save_ply(
            points, rgb, mask, out / "cloud" / f"{path.stem}.ply", stride=args.stride
        )

        valid = np.isfinite(depth) & (depth > 1e-6)
        if mask is not None:
            valid &= mask.astype(bool)
        near = float(np.percentile(depth[valid], 5)) if valid.any() else 0.0
        far = float(np.percentile(depth[valid], 95)) if valid.any() else 0.0

        entry = {
            "photo": path.name,
            "fovDeg": round(fov_deg, 2),
            "depthRangeM": [round(near, 2), round(far, 2)],
            "tearRisk": round(risk, 4),
            "parallaxBudget": parallax_budget(risk),
            "points": n_points,
        }
        report.append(entry)
        print(
            f"[{i}/{len(images)}] {path.name:<34} "
            f"fov={entry['fovDeg']:>5.1f}deg  "
            f"depth={near:>4.1f}-{far:<5.1f}m  "
            f"tear={risk:.3f}  budget={entry['parallaxBudget']:.2f}m"
        )

    (out / "report.json").write_text(json.dumps(report, indent=2))

    risks = sorted(report, key=lambda r: r["tearRisk"], reverse=True)
    mean_risk = sum(r["tearRisk"] for r in report) / len(report)
    print(f"\n{'=' * 62}\nmean tear risk: {mean_risk:.3f}")
    print("worst photos (inspect these clouds first):")
    for r in risks[:5]:
        print(f"  {r['tearRisk']:.3f}  {r['photo']}")
    print(
        "\nNow go LOOK at pipeline/out/cloud/*.ply. The decision gate is visual:\n"
        "  clean geometry, walls flat, edges sane  -> full 2.5D plan\n"
        "  soup, warped walls, windows punched out -> flat photo nodes only\n"
        f"{'=' * 62}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
