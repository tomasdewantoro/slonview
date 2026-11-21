"""Shape text with HarfBuzz and emit outlined SVG path data from the OFL variable fonts in ../fonts.

Vendored from the Stage 2 concept build (concepts/build/outline.py, internal, not published).
Only the two identity fonts are kept; the shaping code is unchanged.
"""
from functools import lru_cache
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

FONTS = Path(__file__).resolve().parent.parent / "fonts"
FILES = {
    "hanken": "HankenGrotesk[wght].ttf",
    "jetbrains": "JetBrainsMono[wght].ttf",
}


@lru_cache(None)
def _instance(font: str, axes: tuple):
    tt = TTFont(FONTS / FILES[font])
    return instantiateVariableFont(tt, dict(axes))


@lru_cache(None)
def _hb_font(font: str, axes: tuple):
    blob = hb.Blob.from_file_path(str(FONTS / FILES[font]))
    f = hb.Font(hb.Face(blob))
    f.set_variations(dict(axes))
    return f


def shape(text, font, axes, size, tracking=0.0, features=None):
    """Return (glyphs, advance) where glyphs = [(glyph_name, x, y)] in px at `size`; tracking in em."""
    axes = tuple(sorted(axes.items()))
    hbf = _hb_font(font, axes)
    upem = hbf.face.upem
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbf, buf, features or {"kern": True, "liga": False})
    tt = _instance(font, axes)
    order = tt.getGlyphOrder()
    s = size / upem
    x = 0.0
    out = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        out.append((order[info.codepoint], x + pos.x_offset * s, pos.y_offset * s))
        x += pos.x_advance * s + tracking * size
    return out, x - tracking * size


def glyph_path(font, axes, name, size, x, y):
    """SVG path data for one glyph, baseline at y, left at x (SVG y-down)."""
    tt = _instance(font, tuple(sorted(axes.items())))
    gs = tt.getGlyphSet()
    s = size / tt["head"].unitsPerEm
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    gs[name].draw(TransformPen(pen, (s, 0, 0, -s, x, y)))
    return pen.getCommands()


def text_path(text, font, axes, size, x=0.0, y=0.0, tracking=0.0, substitute=None):
    """Outlined path data for `text`. `substitute` maps index -> glyph name (e.g. dotless i)."""
    glyphs, adv = shape(text, font, axes, size, tracking)
    parts = []
    for i, (name, gx, gy) in enumerate(glyphs):
        if substitute and i in substitute:
            name = substitute[i]
        parts.append(glyph_path(font, axes, name, size, x + gx, y - gy))
    return " ".join(p for p in parts if p), adv, glyphs


def metrics(font, axes):
    tt = _instance(font, tuple(sorted(axes.items())))
    os2 = tt["OS/2"]
    upem = tt["head"].unitsPerEm
    return {"cap": os2.sCapHeight / upem, "x": os2.sxHeight / upem, "upem": upem}


def glyph_bounds(font, axes, name, size):
    from fontTools.pens.boundsPen import BoundsPen

    tt = _instance(font, tuple(sorted(axes.items())))
    gs = tt.getGlyphSet()
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    s = size / tt["head"].unitsPerEm
    xmin, ymin, xmax, ymax = bp.bounds
    return xmin * s, ymin * s, xmax * s, ymax * s, gs[name].width * s
