"""
Generate the bundled demo property: photos, depth maps, and property.json.

These are synthetic on purpose. Real listing photos are the eventual input, but
they cannot verify the viewer, because with a real photo there is no ground
truth to check the reconstruction against - if the parallax looks subtly wrong
you cannot tell whether the renderer or the depth model is at fault.

Here the depth is exact by construction, so any error in the 2.5D shell is
unambiguously the renderer's. The rooms are deliberately textured and include a
blown-out window, because a flat wall shows no parallax at all and would hide
bugs rather than reveal them.

    python pipeline/make_demo_assets.py

Writes into public/properties/demo-house/.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 960, 640
OUT = Path("public/properties/demo-house")

# Plan-space is metres: x right, y "north". Height is a separate axis.
CEILING = 2.7

ROOMS = [
    # id, label, x0, y0, x1, y1
    ("living", "Living Room", 0.0, 0.0, 5.5, 4.5),
    ("kitchen", "Kitchen", 5.5, 0.0, 9.5, 4.5),
    ("hall", "Hallway", 0.0, 4.5, 9.5, 6.0),
    ("bedroom", "Bedroom", 0.0, 6.0, 5.0, 10.0),
    ("bath", "Bathroom", 5.0, 6.0, 9.5, 10.0),
]

OPENINGS = [
    ("o1", "living", "kitchen", 5.5, 2.2, 1.0),
    ("o2", "living", "hall", 2.5, 4.5, 1.1),
    ("o3", "kitchen", "hall", 7.5, 4.5, 0.9),
    ("o4", "hall", "bedroom", 2.5, 6.0, 0.9),
    ("o5", "hall", "bath", 7.0, 6.0, 0.8),
]

# Furniture as axis-aligned boxes: room, x0, y0, z0, x1, y1, z1, colour.
# Their job is to create real depth discontinuities for the shell to cope with.
FURNITURE = [
    ("living", 0.4, 0.5, 0.0, 2.6, 1.4, 0.85, (96, 84, 76)),
    ("living", 3.4, 2.6, 0.0, 4.9, 3.9, 0.45, (130, 108, 86)),
    ("kitchen", 5.7, 0.2, 0.0, 9.3, 0.9, 0.92, (172, 168, 160)),
    ("kitchen", 6.4, 2.8, 0.0, 8.6, 3.9, 0.78, (150, 142, 132)),
    ("bedroom", 1.0, 6.6, 0.0, 3.9, 9.0, 0.62, (118, 104, 120)),
    ("bath", 5.4, 9.0, 0.0, 6.6, 9.8, 0.85, (196, 198, 202)),
]

# Camera nodes. Expressed as stand-here, look-at-there, because that is how a
# photographer actually frames a room - back into a corner and shoot across the
# long diagonal. Heading is derived, so moving a camera cannot desync the two.
# Fields: id, room, eye x, eye y, target x, target y, photo stem.
NODES = [
    ("n1", "living", 0.9, 0.9, 4.8, 4.3, "living-01"),
    ("n2", "living", 5.0, 4.0, 0.9, 0.5, "living-02"),
    ("n3", "kitchen", 9.0, 4.0, 6.0, 0.4, "kitchen-01"),
    ("n4", "hall", 0.7, 5.25, 9.2, 5.4, "hall-01"),
    ("n5", "bedroom", 0.8, 6.5, 4.4, 9.7, "bedroom-01"),
    ("n6", "bath", 5.5, 6.5, 9.2, 9.6, "bath-01"),
]


def heading_between(cx: float, cy: float, tx: float, ty: float) -> float:
    """Compass heading from eye to target: 0 is +y in plan-space, clockwise."""
    return math.degrees(math.atan2(tx - cx, ty - cy)) % 360.0


EYE = 1.5
FOV_DEG = 78.0


# Outer envelope of the building, used to decide which walls face outside.
HOUSE_X = (0.0, 9.5)
HOUSE_Y = (0.0, 10.0)


def exterior_wall(x0: float, y0: float, x1: float, y1: float):
    """
    Pick the room wall that lies on the building perimeter, as
    (axis, value, span_lo, span_hi) where axis 0 is an x-wall and 1 a y-wall.

    Windows only make sense on an outside wall, and the widest one gets it -
    that is where a real house would put the glass.
    """
    candidates = []
    if abs(x0 - HOUSE_X[0]) < 1e-6:
        candidates.append((0, x0, y0, y1))
    if abs(x1 - HOUSE_X[1]) < 1e-6:
        candidates.append((0, x1, y0, y1))
    if abs(y0 - HOUSE_Y[0]) < 1e-6:
        candidates.append((1, y0, x0, x1))
    if abs(y1 - HOUSE_Y[1]) < 1e-6:
        candidates.append((1, y1, x0, x1))
    if not candidates:
        return None
    return max(candidates, key=lambda c: c[3] - c[2])


def room_bounds(room_id: str):
    for r in ROOMS:
        if r[0] == room_id:
            return r[2], r[3], r[4], r[5]
    raise KeyError(room_id)


def checker(u, v, scale=0.55, amount=14.0):
    """Faint grid keyed to world position, so parallax is actually visible."""
    return (((np.floor(u / scale) + np.floor(v / scale)) % 2) - 0.5) * amount


def render(node) -> tuple[np.ndarray, np.ndarray]:
    """Returns (rgb uint8, euclidean ray depth in metres)."""
    _, room_id, cx, cy, tx, ty, _ = node
    heading = heading_between(cx, cy, tx, ty)
    x0, y0, x1, y1 = room_bounds(room_id)

    h = math.radians(heading)
    forward = np.array([math.sin(h), math.cos(h), 0.0])
    right = np.array([math.cos(h), -math.sin(h), 0.0])
    up = np.array([0.0, 0.0, 1.0])

    tan_x = math.tan(math.radians(FOV_DEG) / 2)
    tan_y = tan_x * H / W
    sx = np.linspace(-tan_x, tan_x, W)
    sy = np.linspace(tan_y, -tan_y, H)
    gx, gy = np.meshgrid(sx, sy)

    d = (
        forward[None, None, :]
        + right[None, None, :] * gx[..., None]
        + up[None, None, :] * gy[..., None]
    )
    d /= np.linalg.norm(d, axis=-1, keepdims=True)

    origin = np.array([cx, cy, EYE])
    lo = np.array([x0, y0, 0.0])
    hi = np.array([x1, y1, CEILING])

    # Camera sits inside the room shell, so the surface it sees is where the ray
    # *exits* the box: the smallest positive slab exit across the three axes.
    safe = np.where(np.abs(d) < 1e-9, 1e-9, d)
    t_lo = (lo - origin) / safe
    t_hi = (hi - origin) / safe
    t_exit = np.maximum(t_lo, t_hi).min(axis=-1)

    hit_t = t_exit.copy()
    # Face id: 0 floor, 1 ceiling, 2 wall, 3 furniture, 4 window.
    face = np.full((H, W), 2, dtype=np.int32)
    point = origin + d * hit_t[..., None]
    face[point[..., 2] < 0.02] = 0
    face[point[..., 2] > CEILING - 0.02] = 1

    # Furniture: ray-box from outside, nearest hit that beats the shell.
    for f_room, fx0, fy0, fz0, fx1, fy1, fz1, colour in FURNITURE:
        if f_room != room_id:
            continue
        b_lo = np.array([fx0, fy0, fz0])
        b_hi = np.array([fx1, fy1, fz1])
        tl = (b_lo - origin) / safe
        th = (b_hi - origin) / safe
        t_near = np.minimum(tl, th).max(axis=-1)
        t_far = np.maximum(tl, th).min(axis=-1)
        mask = (t_near < t_far) & (t_near > 0.05) & (t_near < hit_t)
        hit_t = np.where(mask, t_near, hit_t)
        face = np.where(mask, 3, face)
        point = origin + d * hit_t[..., None]

    point = origin + d * hit_t[..., None]

    rgb = np.zeros((H, W, 3), dtype=np.float32)
    rgb[face == 0] = np.array([124, 101, 78], dtype=np.float32)
    rgb[face == 1] = np.array([238, 238, 240], dtype=np.float32)
    rgb[face == 2] = np.array([206, 203, 197], dtype=np.float32)

    for f_room, fx0, fy0, fz0, fx1, fy1, fz1, colour in FURNITURE:
        if f_room != room_id:
            continue
        inside = (
            (point[..., 0] > fx0 - 0.02) & (point[..., 0] < fx1 + 0.02)
            & (point[..., 1] > fy0 - 0.02) & (point[..., 1] < fy1 + 0.02)
            & (point[..., 2] < fz1 + 0.02)
        )
        rgb[(face == 3) & inside] = np.array(colour, dtype=np.float32)

    # A blown-out window, placed on whichever of the room's walls actually sits
    # on the building perimeter. MLS photos are full of these, and they are the
    # single most common way monocular depth goes wrong, so the demo should not
    # quietly omit the hardest case it will have to handle.
    wall = exterior_wall(x0, y0, x1, y1)
    if wall is not None:
        axis, value, lo_span, hi_span = wall
        mid = (lo_span + hi_span) / 2
        other = point[..., 1 - axis]
        win = (
            (np.abs(point[..., axis] - value) < 0.05)
            & (point[..., 2] > 0.95) & (point[..., 2] < 2.15)
            & (other > mid - 0.9) & (other < mid + 0.9)
        )
        face[win] = 4
        rgb[win] = np.array([252, 251, 246], dtype=np.float32)

    tex = checker(point[..., 0], point[..., 1])
    wall_tex = checker(point[..., 0] + point[..., 1], point[..., 2], 0.45, 9.0)
    rgb[face == 0] += tex[face == 0][..., None]
    rgb[face == 2] += wall_tex[face == 2][..., None]

    # Cheap distance falloff so the eye reads depth even in a still frame.
    shade = np.clip(1.15 - hit_t * 0.055, 0.45, 1.0)
    rgb *= shade[..., None]
    rgb[face == 4] = np.array([252, 251, 246], dtype=np.float32)  # window stays hot

    return np.clip(rgb, 0, 255).astype(np.uint8), hit_t.astype(np.float32)


def depth_to_png(depth: np.ndarray) -> Image.Image:
    """
    Depth packed as 24-bit millimetres across the RGB channels.

    A 16-bit PNG would be the obvious choice, but browsers decode one down to
    8 bits per channel on the way into a canvas or texture, silently destroying
    the precision. Splitting millimetres across R, G and B survives that path
    intact and gives 1mm resolution out to 16km, which is ample for interiors.

    The shader reverses this exactly, so the texture must be uploaded with
    nearest filtering and no colour-space conversion or the bytes get mangled.
    """
    mm = np.clip(depth * 1000.0, 0, 2**24 - 1).astype(np.uint32)
    packed = np.stack(
        [(mm >> 16) & 0xFF, (mm >> 8) & 0xFF, mm & 0xFF], axis=-1
    ).astype(np.uint8)
    return Image.fromarray(packed, mode="RGB")


def main() -> None:
    (OUT / "photos").mkdir(parents=True, exist_ok=True)
    (OUT / "depth").mkdir(parents=True, exist_ok=True)

    nodes_json = []
    for node in NODES:
        node_id, room_id, cx, cy, tx, ty, stem = node
        heading = heading_between(cx, cy, tx, ty)
        rgb, depth = render(node)
        Image.fromarray(rgb).save(OUT / "photos" / f"{stem}.jpg", quality=90)
        depth_to_png(depth).save(OUT / "depth" / f"{stem}.png")

        near, far = float(np.percentile(depth, 2)), float(np.percentile(depth, 98))
        print(f"{stem:<14} heading {heading:5.1f}deg  depth {near:4.1f}-{far:4.1f}m")

        nodes_json.append({
            "id": node_id,
            "roomId": room_id,
            "position": [cx, cy],
            "eyeHeight": EYE,
            "heading": round(heading, 1),
            "pitch": 0,
            "fovDeg": FOV_DEG,
            "photo": f"/properties/demo-house/photos/{stem}.jpg",
            "depth": f"/properties/demo-house/depth/{stem}.png",
            "parallaxBudget": 0.45,
            "neighbors": [],
        })

    property_json = {
        "id": "demo-house",
        "label": "Demo House (synthetic)",
        "displayUnits": "ft",
        "plan": {
            "scaleRef": {"px": 1, "meters": 0.3048},
            "rooms": [
                {
                    "id": rid,
                    "label": label,
                    # Counter-clockwise in plan-space.
                    "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                    "ceilingHeight": CEILING,
                }
                for rid, label, x0, y0, x1, y1 in ROOMS
            ],
            "openings": [
                {"id": oid, "between": [a, b], "at": [x, y], "width": w}
                for oid, a, b, x, y, w in OPENINGS
            ],
        },
        "nodes": nodes_json,
        "splats": [],
    }

    (OUT / "property.json").write_text(json.dumps(property_json, indent=2))
    print(f"\nwrote {OUT}/property.json  ({len(ROOMS)} rooms, {len(NODES)} nodes)")


if __name__ == "__main__":
    main()
