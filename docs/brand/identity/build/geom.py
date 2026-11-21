"""Vector path helpers and the outlined Slonview wordmark (Concept A).

Vendored from the Stage 2 concept build (concepts/build/geom.py, internal, not published), trimmed to
what the Stage 3 identity build uses. Concept B geometry and its fonts were dropped. The code that
remains is unchanged, so the outputs are byte-identical to the Stage 2 helpers.
"""
import pathops

from outline import glyph_bounds, metrics, shape, text_path

# ---------------------------------------------------------------- path helpers

def rrect(x, y, w, h, r):
    p = pathops.Path()
    pen = p.getPen()
    r = min(r, w / 2, h / 2)
    k = 0.5522847498 * r
    pen.moveTo((x + r, y))
    pen.lineTo((x + w - r, y))
    pen.curveTo((x + w - r + k, y), (x + w, y + r - k), (x + w, y + r))
    pen.lineTo((x + w, y + h - r))
    pen.curveTo((x + w, y + h - r + k), (x + w - r + k, y + h), (x + w - r, y + h))
    pen.lineTo((x + r, y + h))
    pen.curveTo((x + r - k, y + h), (x, y + h - r + k), (x, y + h - r))
    pen.lineTo((x, y + r))
    pen.curveTo((x, y + r - k), (x + r - k, y), (x + r, y))
    pen.closePath()
    return p

def rect(x, y, w, h):
    return rrect(x, y, w, h, 0)

def union(*paths):
    out = pathops.Path()
    for p in paths:
        out = pathops.op(out, p, pathops.PathOp.UNION)
    return out

def diff(a, *bs):
    for b in bs:
        a = pathops.op(a, b, pathops.PathOp.DIFFERENCE)
    return a

def d(path, nd=2):
    """Path -> SVG d string."""
    out = []
    fmt = lambda v: (f"{v:.{nd}f}").rstrip("0").rstrip(".") if "." in f"{v:.{nd}f}" else f"{v:.{nd}f}"
    for verb, pts in path.segments:
        if verb == "moveTo":
            out.append("M" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts))
        elif verb == "lineTo":
            out.append("L" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts))
        elif verb == "curveTo":
            out.append("C" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts))
        elif verb == "qCurveTo":
            out.append("Q" + " ".join(f"{fmt(x)} {fmt(y)}" for x, y in pts))
        elif verb in ("closePath", "endPath"):
            out.append("Z")
    return "".join(out)

# ---------------------------------------------------------------- wordmark

def wordmark(size=100):
    """Outlined wordmark. Returns dict(paths=[(role, d)], width, cap, x, font, weight, tracking, size)."""
    font, axes, tracking = "hanken", {"wght": 640}, -0.012
    text = "Slonview"
    i_idx = text.index("i")
    main, adv, glyphs = text_path(text, font, axes, size, tracking=tracking, substitute={i_idx: "dotlessi"})
    m = metrics(font, axes)
    # i-dot becomes a short horizontal row in the accent colour
    name, gx, _ = glyphs[i_idx]
    bx0, by0, bx1, by1, w = glyph_bounds(font, axes, "dotlessi", size)
    stem = bx1 - bx0
    cx = gx + (bx0 + bx1) / 2
    dot_h = stem * 0.92
    dot_w = stem * 2.1
    top = -(m["x"] * size) - stem * 0.62 - dot_h
    dot = rrect(cx - stem / 2, top, dot_w, dot_h, dot_h / 2)
    return {
        "paths": [("ink", main), ("accent", d(dot))],
        "width": max(adv, cx - stem / 2 + dot_w),
        "cap": m["cap"] * size,
        "x": m["x"] * size,
        "font": "Hanken Grotesk",
        "weight": 640,
        "tracking": tracking,
        "size": size,
    }
