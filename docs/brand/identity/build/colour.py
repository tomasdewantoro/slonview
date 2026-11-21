"""Colour maths for the Slonview identity: WCAG 2.x contrast, CIELAB dE76, CVD simulation.

Pure Python (no numpy). CVD uses Machado, Oliveira & Fernandes 2009 matrices at severity 1.0,
applied in linear sRGB, as in the Stage 2 concept review.
"""
import colorsys


def rgb(hexcol):
    h = hexcol.lstrip("#")
    return [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]


def _lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _delin(c):
    c = min(max(c, 0.0), 1.0)
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def luminance(hexcol):
    r, g, b = (_lin(c) for c in rgb(hexcol))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def blend(fg, bg, alpha):
    """Composite fg over bg at alpha (sRGB space, as browsers do)."""
    f, b = rgb(fg), rgb(bg)
    return "#" + "".join(f"{round((alpha * x + (1 - alpha) * y) * 255):02X}" for x, y in zip(f, b))


_M = ((0.4124564, 0.3575761, 0.1804375), (0.2126729, 0.7151522, 0.0721750), (0.0193339, 0.1191920, 0.9503041))
_W = (0.95047, 1.0, 1.08883)


def _mul(m, v):
    return [sum(m[i][j] * v[j] for j in range(3)) for i in range(3)]


def _lab_lin(lin):
    xyz = _mul(_M, lin)
    f = []
    for v, w in zip(xyz, _W):
        t = v / w
        f.append(t ** (1 / 3) if t > (6 / 29) ** 3 else t / (3 * (6 / 29) ** 2) + 4 / 29)
    return (116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2]))


def lab(hexcol):
    return _lab_lin([_lin(c) for c in rgb(hexcol)])


PROTAN = ((0.152286, 1.052583, -0.204868), (0.114503, 0.786281, 0.099216), (-0.003882, -0.048116, 1.051998))
DEUTAN = ((0.367322, 0.860646, -0.227968), (0.280085, 0.672501, 0.047413), (-0.011820, 0.042940, 0.968881))


def simulate(hexcol, matrix):
    lin = _mul(matrix, [_lin(c) for c in rgb(hexcol)])
    return "#" + "".join(f"{round(_delin(c) * 255):02X}" for c in lin)


def delta_e(a, b, cvd=None):
    if cvd:
        m = PROTAN if cvd == "protan" else DEUTAN
        a, b = simulate(a, m), simulate(b, m)
    la, lb = lab(a), lab(b)
    return sum((x - y) ** 2 for x, y in zip(la, lb)) ** 0.5


def hue(hexcol):
    return colorsys.rgb_to_hls(*rgb(hexcol))[0] * 360


def hue_gap(a, b):
    g = abs(hue(a) - hue(b)) % 360
    return min(g, 360 - g)
