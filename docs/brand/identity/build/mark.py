"""Slonview mark geometry (Concept A, Viewport in motion), Stage 3.

The frame is a closed landscape rectangle. The right wall keeps a notch exactly one row tall
(plus a hairline clearance), and the accent row passes through it. Two quiet rows sit inside the
frame above and below the accent row. Three masters: 64-unit symbol, hand-tuned 32 px, hand-tuned 16 px.
"""
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[2] / "concepts" / "build"))

from geom import d, diff, rect, rrect, union  # noqa: E402

# ------------------------------------------------------------------ 64-unit master
F64 = dict(x=4, y=12, w=44, h=40, r=9, t=5.5)
ROW64 = dict(x0=13, x1=61, y=28, h=8)
NOTCH64 = 1.6  # clearance above and below the row inside the notch
QUIET64 = dict(x0=13, x1=37, h=3.6, ys=(20.6, 39.8))


def symbol64(row_x1=None):
    """row_x1 lets large applications (social card, README header) run the row off the canvas edge."""
    f, r = F64, ROW64
    outer = rrect(f["x"], f["y"], f["w"], f["h"], f["r"])
    inner = rrect(f["x"] + f["t"], f["y"] + f["t"], f["w"] - 2 * f["t"], f["h"] - 2 * f["t"], f["r"] - f["t"] * 0.7)
    notch = rect(f["x"] + f["w"] - f["t"] - 1, r["y"] - NOTCH64, f["t"] + 2, r["h"] + 2 * NOTCH64)
    frame = diff(outer, inner, notch)
    x1 = row_x1 or r["x1"]
    row = rrect(r["x0"], r["y"], x1 - r["x0"], r["h"], r["h"] / 2)
    q = QUIET64
    quiet = union(*[rrect(q["x0"], y, q["x1"] - q["x0"], q["h"], q["h"] / 2) for y in q["ys"]])
    return {"frame": frame, "quiet": quiet, "row": row}


# ------------------------------------------------------------------ hand-tuned 32 px (pixel grid)
def symbol32(ox=3, oy=6, row_end=31):
    """Whole-pixel geometry. Frame 20 x 19, 2 px walls; quiet rows 2 px; accent row 3 px.
    The right wall is closed except a notch of row height + 1 px clearance each side."""
    outer = rrect(ox, oy, 20, 19, 3.5)
    inner = rrect(ox + 2, oy + 2, 16, 15, 1.5)
    notch = rect(ox + 17.5, oy + 7, 3, 5)
    frame = diff(outer, inner, notch)
    quiet = union(rect(ox + 4, oy + 4, 8, 2), rect(ox + 4, oy + 13, 8, 2))
    row = rrect(ox + 4, oy + 8, row_end - ox - 4, 3, 1.5)
    return {"frame": frame, "quiet": quiet, "row": row}


# ------------------------------------------------------------------ hand-tuned 16 px (pixel grid)
def symbol16(ox=1, oy=3, row_end=15):
    """Whole-pixel geometry. Frame 10 x 10, 1 px walls; quiet rows 1 px; accent row 2 px.
    Notch = row + 1 px each side, so the wall above and below the row stays 3 px tall."""
    outer = rrect(ox, oy, 10, 10, 1.5)
    inner = rect(ox + 1, oy + 1, 8, 8)
    notch = rect(ox + 8.5, oy + 3, 2, 4)
    frame = diff(outer, inner, notch)
    quiet = union(rect(ox + 2, oy + 2, 5, 1), rect(ox + 2, oy + 7, 5, 1))
    row = rect(ox + 2, oy + 4, row_end - ox - 2, 2)
    return {"frame": frame, "quiet": quiet, "row": row}


def icon_glyph(n):
    """Glyph placement inside the hand-tuned small app-icon tiles."""
    return symbol16(ox=2, oy=3, row_end=14) if n == 16 else symbol32(ox=5, oy=6, row_end=29)


MASTERS = {64: symbol64, 32: symbol32, 16: symbol16}


def paths_svg(parts, cols, ids=True):
    out = []
    for k in ("frame", "quiet", "row"):
        c = cols.get(k)
        if c is None:
            continue
        idattr = f' id="{k}"' if ids else ""
        out.append(f'<path{idattr} fill="{c}" d="{d(parts[k])}"/>')
    return "".join(out)
