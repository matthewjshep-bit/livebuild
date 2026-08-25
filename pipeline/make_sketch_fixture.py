"""
Generate a hand-drawn floor plan to test sketch reading against.

Real test material would be a phone photo of paper, which cannot be checked into
a repo and cannot be regenerated. This imitates one - wobbly freehand lines,
handwritten labels, a slight camera angle, uneven lighting - from a layout whose
ground truth is written down below, so the reading can actually be scored.

    pipeline/.venv/bin/python pipeline/make_sketch_fixture.py
"""

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path("public/fixtures")
W, H = 1400, 1050
INK = (38, 42, 55)

# Ground truth, in percent of the drawing. Rooms share edges exactly.
ROOMS = [
    ("Living Room", 6, 8, 46, 48, "16x14"),
    ("Kitchen", 46, 8, 94, 30, "12x11"),
    ("Dining", 46, 30, 94, 48, None),
    ("Hall", 6, 48, 94, 58, None),
    ("Bedroom", 6, 58, 50, 92, "12x12"),
    ("Bath", 50, 58, 94, 92, None),
]

random.seed(7)


def wobble(draw, x0, y0, x1, y1, width=4, jitter=3.0):
    """A straight line drawn by hand: many short segments, each slightly off."""
    steps = max(6, int(math.hypot(x1 - x0, y1 - y0) / 26))
    points = []
    for i in range(steps + 1):
        t = i / steps
        points.append(
            (
                x0 + (x1 - x0) * t + random.uniform(-jitter, jitter),
                y0 + (y1 - y0) * t + random.uniform(-jitter, jitter),
            )
        )
    # Drawn twice, as people do when a line does not look dark enough.
    draw.line(points, fill=INK, width=width, joint="curve")
    if random.random() < 0.5:
        draw.line(
            [(x + random.uniform(-1.5, 1.5), y + random.uniform(-1.5, 1.5)) for x, y in points],
            fill=INK,
            width=max(1, width - 2),
            joint="curve",
        )


def load_font(size):
    for path in (
        "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf",
        "/System/Library/Fonts/Supplemental/Chalkduster.ttf",
        "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # Slightly off-white paper with a faint grain.
    paper = Image.new("RGB", (W, H), (250, 248, 242))
    grain = Image.effect_noise((W, H), 7).convert("L").point(lambda v: 245 + v // 22)
    paper = Image.composite(paper, Image.new("RGB", (W, H), (238, 235, 228)), grain)

    draw = ImageDraw.Draw(paper)
    label_font = load_font(38)
    dim_font = load_font(26)

    def px(x, y):
        return (W * 0.06 + x / 100 * W * 0.88, H * 0.06 + y / 100 * H * 0.88)

    for name, x0, y0, x1, y1, dim in ROOMS:
        a, b = px(x0, y0)
        c, d = px(x1, y1)
        wobble(draw, a, b, c, b)
        wobble(draw, c, b, c, d)
        wobble(draw, c, d, a, d)
        wobble(draw, a, d, a, b)

        cx, cy = (a + c) / 2, (b + d) / 2
        text_w = draw.textlength(name, font=label_font)
        draw.text(
            (cx - text_w / 2 + random.uniform(-6, 6), cy - 34 + random.uniform(-5, 5)),
            name,
            font=label_font,
            fill=INK,
        )
        if dim:
            dim_w = draw.textlength(dim, font=dim_font)
            draw.text((cx - dim_w / 2, cy + 14), dim, font=dim_font, fill=(90, 95, 110))

    draw.text((W * 0.06, H * 0.955), "main floor", font=dim_font, fill=(120, 124, 138))

    # Photographed rather than scanned: a small rotation and a lighting gradient.
    paper = paper.rotate(-1.6, resample=Image.BICUBIC, fillcolor=(246, 244, 238), expand=False)

    shade = Image.new("L", (W, H))
    shade_draw = ImageDraw.Draw(shade)
    for x in range(0, W, 8):
        shade_draw.rectangle([x, 0, x + 8, H], fill=int(214 + 40 * (x / W)))
    shade = shade.filter(ImageFilter.GaussianBlur(60))
    paper = Image.composite(paper, Image.new("RGB", (W, H), (206, 203, 196)), shade)

    path = OUT / "sketch-floorplan.jpg"
    paper.save(path, quality=88)

    truth = {
        "rooms": [
            {"label": n, "x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}
            for n, x0, y0, x1, y1, _ in ROOMS
        ],
        # Every pair sharing an edge in the drawing, which is what the reading
        # has to preserve for the plan to be walkable.
        "adjacent": [
            ["Living Room", "Kitchen"], ["Living Room", "Hall"],
            ["Kitchen", "Dining"], ["Dining", "Hall"],
            ["Hall", "Bedroom"], ["Hall", "Bath"],
            ["Bedroom", "Bath"], ["Living Room", "Dining"],
        ],
    }
    (OUT / "sketch-floorplan.truth.json").write_text(json.dumps(truth, indent=2))
    print(f"wrote {path} ({len(ROOMS)} rooms) and its ground truth")


if __name__ == "__main__":
    main()
