# pipeline

Python side of Livebuild.ai. Deliberately separate from the Next.js app: nothing
here runs at request time, and nothing in `src/` imports from it.

One script is left.

## make_sketch_fixture.py

Generates a hand-drawn floor plan with known ground truth, so the sketch reader
can be scored rather than eyeballed. Real test material would be a phone photo
of paper, which cannot be checked into a repository and cannot be regenerated;
this imitates one - wobbly lines, handwritten labels, a slight camera angle,
uneven lighting - from a layout written down beside it.

```bash
uv venv --python 3.12 pipeline/.venv
source pipeline/.venv/bin/activate
uv pip install pillow numpy
python pipeline/make_sketch_fixture.py
```

It writes `public/fixtures/sketch-floorplan.jpg` and its `.truth.json`, which
`tools/sketch-test.ts` reads.

## What used to be here, and why it is not

**The Phase 0 depth spike** - `spike.py`, `spike.ipynb` and a torch/MoGe
requirements file - asked whether monocular depth survives real MLS photos,
because a 2.5D shell renderer depended on the answer. The project answered it by
going the other way: photographs came off the model entirely, and the shell
renderer, the depth pass and the node-teleport camera went with them. The model
is built from the plan now, so there is nothing for a depth map to displace.

It stayed here long enough to become misleading - a README describing the
central question of an approach the repository had already abandoned, next to a
`depth/` folder of PNGs nothing loaded and two schema fields nothing read.

**`make_demo_assets.py`** generated the bundled demo property together with
those depth maps. The property JSON it produced is checked in and still used;
the depth half had nothing left to feed.
