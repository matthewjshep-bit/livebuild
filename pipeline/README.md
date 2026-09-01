# pipeline

Python side of Livebuild.ai. Deliberately separate from the Next.js app: nothing
here runs at request time, and nothing in `src/` imports from it. The two meet
only at the property JSON described in `src/lib/schema.ts`.

## Phase 0 - the spike

Run this before trusting any of the 2.5D work. It answers the one question that
could sink the interesting half of the project: **does monocular depth survive
real MLS photos?** Listing photos are wide-angle, heavily tone-mapped, and full
of blown-out windows, which is a different problem from the clean phone captures
these models are usually demoed on.

### On Colab (recommended)

The free T4 is plenty. Open `spike.ipynb`, upload a folder of one property's
photos, run all cells. No local GPU needed.

### Locally

Needs a CUDA GPU or Apple Silicon. Note that torch has no wheels for Python 3.14
yet, so use 3.11 or 3.12:

```bash
uv venv --python 3.12 pipeline/.venv
source pipeline/.venv/bin/activate
uv pip install -r pipeline/requirements.txt
uv pip install git+https://github.com/microsoft/MoGe.git

python pipeline/spike.py --photos photos/123-main-st --out pipeline/out
```

### Reading the result

The script writes to `pipeline/out/`:

| Output | What it is |
|---|---|
| `depth/*.png` | Depth previews, near = bright. Check window and mirror edges. |
| `cloud/*.ply` | Coloured point clouds. **This is the actual deliverable.** |
| `report.json` | Per-photo FOV, depth range, tear risk, suggested parallax budget. |

**The decision gate is visual, not numeric.** Open the point clouds (Blender,
MeshLab, or https://3dviewer.net) and orbit them. `tearRisk` only ranks which
photos to inspect first.

| What you see | What to build |
|---|---|
| Walls flat, room shape reads correctly, edges sane | Full 2.5D plan |
| Geometry sound but noisy in places | 2.5D with a tighter parallax budget |
| Warped walls, soup, windows punched into infinity | Flat photo nodes + dollhouse only |

That last row is not a failure of the project. The dollhouse and the click-to-walk
tour do not depend on any of this - they come from the hand-drawn floor plan. Only
the in-room parallax is at stake here.

### Tear risk, and why it exists

A 2.5D shell is one displaced grid: it can stretch across a depth jump but can
never reveal what sits behind it. So the density of depth discontinuities in a
photo predicts how far the camera may drift before the illusion visibly breaks.
`tearRisk` measures that, and maps to the `parallaxBudget` the viewer clamps to.

Constraining camera motion is not a workaround - it is what Matterport does too.

## Licensing

| Component | License | Note |
|---|---|---|
| MoGe-2 | MIT | ViT-S/B/L checkpoints commercially usable. Clean. |
| VGGT code | Commercial-friendly | Excludes military use. |
| VGGT weights | **Gated** | Must use `VGGT-1B-Commercial`. Apply early - approval is a form. |
| Depth Anything V2 | Mixed | Only Small is Apache-2.0; Base/Large/Giant are CC-BY-NC. Avoid. |

## Phase 3 (later)

`video -> frames -> hosted API -> .ply/.spz -> SOG -> Spark`. Deliberately not
built yet. The `splats` field already exists in the schema so it drops into the
same plan-space world frame when it arrives.
