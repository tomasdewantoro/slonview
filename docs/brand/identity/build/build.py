"""Build every Slonview Stage 3 identity asset (Concept A, Viewport in motion).

Run from this folder:  python3 build.py
Needs: fonttools, uharfbuzz, skia-pathops, pillow, and `rsvg-convert` on PATH.
Path ops, wordmark outlines and text shaping live in geom.py and outline.py (fonts from ../fonts).
The Stage 2 inputs for the before/after misread check are frozen in ../checks/stage2-reference/.
Outputs: ../symbol ../wordmark ../lockup ../favicon ../appicon ../social ../readme ../motion ../checks
         ../tokens.json ../tokens.css
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image

import colour as C
from brand_palette import BRAND, FUNCTIONAL, GROUNDS, ICON, SYMBOL_COLOURS, WORDMARK_COLOURS
from mark import icon_glyph, paths_svg, symbol16, symbol32, symbol64
from geom import d, diff, rect, rrect, union, wordmark
from outline import shape, text_path

HERE = Path(__file__).resolve().parent
ID = HERE.parent
REPO = ID.parents[2]
STAGE2 = ID / "checks" / "stage2-reference"
DIRS = {k: ID / k for k in ("symbol", "wordmark", "lockup", "favicon", "appicon", "social", "readme", "motion", "checks")}
for p in DIRS.values():
    p.mkdir(parents=True, exist_ok=True)

MODES = ("light", "dark", "mono", "reversed")
ICON_SIZES = [1024, 512, 256, 128, 64, 32, 16]
FINDER_LIGHT, FINDER_DARK = "#ECECEE", "#1E1E20"


def svg_doc(w, h, body, title, vb=None, extra=""):
    vb = vb or f"0 0 {w:g} {h:g}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="{vb}"{extra}><title>{title}</title>{body}</svg>\n'


def write(path, text):
    path.write_text(text)
    return path


def rsvg(svg, png, w, h=None):
    cmd = ["rsvg-convert", "-w", str(w)] + (["-h", str(h)] if h else []) + [str(svg), "-o", str(png)]
    subprocess.run(cmd, check=True)
    return png


def pngs_1x2x(svg, w, h):
    rsvg(svg, svg.with_name(svg.stem + "@1x.png"), w, h)
    rsvg(svg, svg.with_name(svg.stem + "@2x.png"), 2 * w, 2 * h)


# ====================================================================== symbol
def build_symbol():
    out = DIRS["symbol"]
    for mode in MODES:
        body = paths_svg(symbol64(), SYMBOL_COLOURS[mode])
        f = write(out / f"symbol-{mode}.svg", svg_doc(128, 128, body, f"Slonview symbol, {mode}", vb="0 0 64 64"))
        pngs_1x2x(f, 128, 128)
    for n, fn in ((16, symbol16), (32, symbol32)):
        for mode in MODES:
            body = paths_svg(fn(), SYMBOL_COLOURS[mode])
            f = write(out / f"symbol-{n}px-{mode}.svg", svg_doc(n, n, body, f"Slonview symbol, hand-tuned {n} px, {mode}"))
            rsvg(f, f.with_suffix(".png"), n)
            rsvg(f, f.with_name(f.stem + "@2x.png"), 2 * n)


# ====================================================================== wordmark + lockup
WM = wordmark(100)
PAD = 6


def wordmark_body(mode, ids=True):
    c = WORDMARK_COLOURS[mode]
    return "".join(f'<path{f" id=\"{role}\"" if ids else ""} fill="{c[role]}" d="{p}"/>' for role, p in WM["paths"])


def build_wordmark():
    out = DIRS["wordmark"]
    w, h = round(WM["width"] + 2 * PAD, 2), 132
    base = PAD + 98
    for mode in MODES:
        body = f'<g transform="translate({PAD},{base})">{wordmark_body(mode)}</g>'
        f = write(out / f"wordmark-{mode}.svg", svg_doc(w, h, body, f"Slonview wordmark (outlined), {mode}"))
        pngs_1x2x(f, round(w), h)
    style = (
        "@font-face{font-family:'Hanken Grotesk';src:url('../fonts/HankenGrotesk%5Bwght%5D.ttf') format('truetype');font-weight:100 900}"
        f".wm{{font-family:'Hanken Grotesk';font-size:100px;font-weight:640;font-variation-settings:'wght' 640;letter-spacing:{WM['tracking']}em;fill:{BRAND['ink']}}}"
    )
    note = (
        "Editable text version for layout drafts only. Needs Hanken Grotesk from ../fonts. "
        "The outlined master replaces the i-dot with a short plum row; ship the outlined files."
    )
    body = f'<desc>{note}</desc><style>{style}</style><text class="wm" x="{PAD}" y="{base}">Slonview</text>'
    write(out / "wordmark-editable.svg", svg_doc(w, h, body, "Slonview wordmark (editable text)"))


LOCK = {}


def build_lockup():
    out = DIRS["lockup"]
    sym_h = WM["cap"] * 1.55  # symbol height = 1.55 x cap height
    s = sym_h / 64
    gap = sym_h * 0.42
    lw = PAD + sym_h + gap + WM["width"] + PAD
    lh = sym_h + 2 * PAD + 8
    sym_y = (lh - sym_h) / 2
    wm_base = sym_y + sym_h / 2 + WM["cap"] / 2
    LOCK.update(w=lw, h=lh, sym_h=sym_h, gap=gap, cap=WM["cap"])
    for mode in MODES:
        body = (
            f'<g id="symbol" transform="translate({PAD},{sym_y:.2f}) scale({s:.4f})">{paths_svg(symbol64(), SYMBOL_COLOURS[mode], ids=False)}</g>'
            f'<g id="wordmark" transform="translate({PAD + sym_h + gap:.2f},{wm_base:.2f})">{wordmark_body(mode, ids=False)}</g>'
        )
        f = write(out / f"lockup-horizontal-{mode}.svg", svg_doc(round(lw, 1), round(lh, 1), body, f"Slonview horizontal lockup, {mode}"))
        pngs_1x2x(f, round(lw), round(lh))


def lockup_group(mode, x, y, height):
    """Inline lockup for composed artwork (README header, social card)."""
    k = height / LOCK["h"]
    s = LOCK["sym_h"] / 64
    sym_y = (LOCK["h"] - LOCK["sym_h"]) / 2
    wm_base = sym_y + LOCK["sym_h"] / 2 + LOCK["cap"] / 2
    return (
        f'<g transform="translate({x},{y}) scale({k:.4f})">'
        f'<g transform="translate({PAD},{sym_y:.2f}) scale({s:.4f})">{paths_svg(symbol64(), SYMBOL_COLOURS[mode], ids=False)}</g>'
        f'<g transform="translate({PAD + LOCK["sym_h"] + LOCK["gap"]:.2f},{wm_base:.2f})">{wordmark_body(mode, ids=False)}</g></g>'
    )


# ====================================================================== app icon (macOS 1024 grid)
TILE = (100, 100, 824, 824, 185.4)


def icon_layers(appearance):
    sc = ICON[appearance]
    tx, ty, tw, th, tr = TILE
    tile = rrect(tx, ty, tw, th, tr)
    grad = (
        f'<defs><linearGradient id="tile-{appearance}" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="{sc["tile"]}"/><stop offset="1" stop-color="{sc["tile2"]}"/></linearGradient></defs>'
    )
    rim = ""
    if sc["rim"]:
        inset = rrect(tx + 8, ty + 8, tw - 16, th - 16, tr - 8)
        rim = f'<path d="{d(diff(tile, inset))}" fill="{sc["rim"]}" fill-opacity="0.14"/>'
    bg = f'<g id="background">{grad}<path d="{d(tile)}" fill="url(#tile-{appearance})"/>{rim}</g>'
    gs = tw * 0.74
    gx, gy = tx + tw * 0.13, ty + th * 0.13
    fg_tf = f'translate({gx:.3f},{gy:.3f}) scale({gs / 64:.5f})'
    fg = f'<g id="foreground" transform="{fg_tf}">{paths_svg(symbol64(), sc, ids=False)}</g>'
    return bg, fg, fg_tf


def small_icon_svg(appearance, n):
    sc = ICON[appearance]
    tile = rrect(0.5, 0.5, 15, 15, 3.4) if n == 16 else rrect(1, 1, 30, 30, 6.75)
    rim = ""
    if sc["rim"]:
        inner = rrect(1.5, 1.5, 13, 13, 2.9) if n == 16 else rrect(2, 2, 28, 28, 6.3)
        rim = f'<path fill="#FFFFFF" fill-opacity="0.22" d="{d(diff(tile, inner))}"/>'
    body = f'<g id="background"><path fill="{sc["tile"]}" d="{d(tile)}"/>{rim}</g><g id="foreground">{paths_svg(icon_glyph(n), sc, ids=False)}</g>'
    return svg_doc(n, n, body, f"Slonview app icon, hand-tuned {n} px, {appearance}")


def build_appicon():
    out = DIRS["appicon"]
    for appearance in ("light", "dark"):
        bg, fg, fg_tf = icon_layers(appearance)
        master = write(out / f"icon-{appearance}-1024.svg", svg_doc(1024, 1024, bg + fg, f"Slonview app icon, {appearance} (layered: #background, #foreground)"))
        write(out / f"layer-background-{appearance}.svg", svg_doc(1024, 1024, bg, f"Slonview app icon background layer, {appearance}"))
        for n in (16, 32):
            write(out / f"icon-{appearance}-{n}.svg", small_icon_svg(appearance, n))
        for n in ICON_SIZES:
            src = out / (f"icon-{appearance}-{n}.svg" if n in (16, 32) else master.name)
            rsvg(src, out / f"icon-{appearance}-{n}.png", n)
        for n in (16, 32):
            rsvg(master, out / f"_downscaled-{appearance}-{n}.png", n)
    # foreground layers for tinted / clear appearances (one flat colour per role, transparent ground)
    _, _, fg_tf = icon_layers("light")
    for name, cols in (
        ("layer-foreground-colour", ICON["light"]),
        ("layer-foreground-white", {"frame": "#FFFFFF", "quiet": "#FFFFFF", "row": "#FFFFFF"}),
    ):
        body = f'<g id="foreground" transform="{fg_tf}">{paths_svg(symbol64(), cols, ids=False)}</g>'
        write(out / f"{name}.svg", svg_doc(1024, 1024, body, f"Slonview app icon {name}"))
    grey = {"frame": "#FFFFFF", "quiet": "#B3B3B3", "row": "#E6E6E6"}
    body = f'<g id="foreground" transform="{fg_tf}">{paths_svg(symbol64(), grey, ids=False)}</g>'
    write(out / "layer-foreground-tint-greyscale.svg", svg_doc(1024, 1024, body, "Slonview app icon foreground for macOS tinted mode (greyscale)"))
    shutil.copy(out / "icon-light-1024.svg", out / "icon.svg")


# ====================================================================== favicon
def build_favicon():
    out = DIRS["favicon"]
    tile = rrect(0, 0, 64, 64, 14)
    sc = ICON["light"]
    body = f'<path fill="{sc["tile"]}" d="{d(tile)}"/><g transform="translate(5.6,5.6) scale(0.825)">{paths_svg(symbol64(), sc, ids=False)}</g>'
    f = write(out / "favicon.svg", svg_doc(64, 64, body, "Slonview favicon"))
    rsvg(f, out / "favicon-48.png", 48)
    shutil.copy(DIRS["appicon"] / "icon-light-16.png", out / "favicon-16.png")
    shutil.copy(DIRS["appicon"] / "icon-light-32.png", out / "favicon-32.png")
    ims = [Image.open(out / f"favicon-{n}.png").convert("RGBA") for n in (16, 32, 48)]
    ims[2].save(out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ims[:2])


# ====================================================================== outlined text helper
def text_svg(text, font, weight, size, x, y, fill, tracking=0.0):
    p, adv, _ = text_path(text, font, {"wght": weight}, size, x, y, tracking=tracking)
    return f'<path fill="{fill}" d="{p}"/>', adv


TAG1 = "About 8 MB. Ready for a million rows."
TAG3 = "Look first. Write on purpose."
MACHINE = "MacBook Air (Mac17,3, Apple M5)"
NUMBER = ("1,000,000-row CSV export in ~0.44 s", f"local benchmark: PostgreSQL 18.4, Unix socket, {MACHINE}")
CARD_HEAD = ("About 8 MB. A million", "rows to CSV in 0.44 s.")
CARD_FOOT = f"Local benchmark: 1,000,000-row orders table · PostgreSQL® 18.4 over Unix socket · {MACHINE}"

SCHEMES = {
    "light": {"bg": BRAND["paper"], "ink": BRAND["ink"], "sub": "#4F5661", "num": "#4F5661"},
    "dark": {"bg": BRAND["graphite_deep"], "ink": BRAND["paper"], "sub": "#ADB3BD", "num": "#ADB3BD"},
}


def big_symbol(mode, tx, ty, s, row_x1):
    return f'<g transform="translate({tx},{ty}) scale({s})">{paths_svg(symbol64(row_x1=row_x1), SYMBOL_COLOURS[mode], ids=False)}</g>'


def build_readme():
    out = DIRS["readme"]
    W, H = 1280, 320
    for mode in ("light", "dark"):
        sc = SCHEMES[mode]
        parts = [f'<rect width="{W}" height="{H}" fill="{sc["bg"]}"/>', lockup_group(mode, 66, 40, 76)]
        t, _ = text_svg(TAG1, "hanken", 650, 40, 76, 176, sc["ink"], -0.01)
        n1, nadv = text_svg(NUMBER[0], "jetbrains", 600, 17, 78, 212, sc["ink"])
        n2, nadv2 = text_svg(NUMBER[1], "jetbrains", 450, 14, 78, 236, sc["num"])
        t3, _ = text_svg(TAG3, "hanken", 500, 24, 76, 284, sc["sub"])
        parts += [t, n1, n2, t3, big_symbol(mode, 1040, 30, 5, 66)]
        f = write(out / f"readme-header-{mode}.svg", svg_doc(W, H, "".join(parts), f"Slonview. {TAG1} {TAG3}"))
        rsvg(f, f.with_suffix(".png"), W, H)
        rsvg(f, f.with_name(f.stem + "@2x.png"), 2 * W, 2 * H)
    return max(nadv, nadv2)


def build_social():
    out = DIRS["social"]
    W, H = 1280, 640
    sc = SCHEMES["light"]
    parts = [f'<rect width="{W}" height="{H}" fill="{sc["bg"]}"/>', lockup_group("light", 74, 66, 84)]
    for i, line in enumerate(CARD_HEAD):
        p, _ = text_svg(line, "hanken", 680, 60, 80, 268 + i * 68, sc["ink"], -0.02)
        parts.append(p)
    p, _ = text_svg(TAG3, "hanken", 500, 30, 80, 418, sc["sub"])
    parts.append(p)
    p, fadv = text_svg(CARD_FOOT, "jetbrains", 450, 15, 80, 584, sc["num"])
    parts.append(p)
    parts.append(big_symbol("light", 793, 14, 6.8, 76))
    f = write(out / "social-card.svg", svg_doc(W, H, "".join(parts), "Slonview. About 8 MB. A million rows to CSV in 0.44 s."))
    rsvg(f, out / "social-card.png", W, H)
    return fadv


# ====================================================================== motion
def build_motion():
    p = symbol64()
    css = (
        "@keyframes sv-slide{0%{transform:translateX(-48px)}70%,100%{transform:translateX(0)}}"
        ".sv-row{animation:sv-slide 2s cubic-bezier(.2,.7,.2,1) infinite}"
        "@media (prefers-reduced-motion:reduce){.sv-row{animation:none}}"
    )
    body = (
        f"<style>{css}</style>"
        '<defs><clipPath id="sv-clip"><rect x="9.5" y="26" width="54.5" height="12"/></clipPath></defs>'
        f'<path fill="{BRAND["ink"]}" d="{d(p["frame"])}"/>'
        f'<path fill="{BRAND["quiet_light"]}" d="{d(p["quiet"])}"/>'
        f'<g clip-path="url(#sv-clip)"><g class="sv-row"><path fill="{BRAND["plum"]}" d="{d(p["row"])}"/></g></g>'
    )
    write(DIRS["motion"] / "symbol-motion-light.svg", svg_doc(256, 256, body, "Slonview symbol, 2 s loop (static when reduced motion is requested)", vb="0 0 64 64"))


# ====================================================================== misread check (16 px)
LUCIDE = {
    "log-out (Lucide)": '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
    "square-arrow-right-exit (Lucide; SF rectangle…arrow.right family)": '<path d="M11 12h10"/><path d="m17 16 4-4-4-4"/><path d="M21 6.33V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-1.33"/>',
    "battery (Lucide)": '<path d="M 22 14 L 22 10"/><rect x="2" y="6" width="16" height="12" rx="2"/>',
    "app-window (Lucide)": '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
    "menu (Lucide)": '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    "scrollbar": '<rect x="2" y="2" width="20" height="20" rx="3"/><rect x="16" y="5" width="2" height="8" rx="1" fill="#3A3F47"/>',
    "progress bar": '<rect x="2" y="9.5" width="20" height="5" rx="2.5"/><rect x="3.5" y="11" width="10" height="2" rx="1" fill="#3A3F47"/>',
}


def misread_glyph_pngs():
    tmp = DIRS["checks"] / "_glyphs"
    tmp.mkdir(exist_ok=True)
    out = {}
    for label, body in LUCIDE.items():
        f = tmp / (label.split(" ")[0] + ".svg")
        f.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3A3F47" '
            f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</svg>'
        )
        out[label] = rsvg(f, f.with_suffix(".png"), 16)
    for ch in ("C", "€"):
        glyphs, adv = shape(ch, "hanken", {"wght": 640}, 17)
        p, _, _ = text_path(ch, "hanken", {"wght": 640}, 17, (16 - adv) / 2, 14)
        f = tmp / f"glyph-{'C' if ch == 'C' else 'euro'}.svg"
        f.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#3A3F47" d="{p}"/></svg>')
        out[f'"{ch}" (Hanken 640)'] = rsvg(f, f.with_suffix(".png"), 16)
    return out, tmp


def ink_mask(png, bg):
    im = Image.new("RGBA", (16, 16), bg)
    im.alpha_composite(Image.open(png).convert("RGBA").resize((16, 16)))
    lum = im.convert("L")
    b = Image.new("RGB", (1, 1), bg).convert("L").getpixel((0, 0))
    return {(x, y) for y in range(16) for x in range(16) if abs(lum.getpixel((x, y)) - b) > 60}


def iou(a, b):
    best = 0.0
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            s = {(x + dx, y + dy) for x, y in a}
            u = len(s | b)
            best = max(best, len(s & b) / u if u else 0)
    return best


def build_misread():
    glyphs, tmp = misread_glyph_pngs()
    # shape-only comparison uses the mono glyphs on white
    ours = {
        "Slonview 16 px (Stage 3)": DIRS["symbol"] / "symbol-16px-mono.png",
    }
    old = tmp / "concept-a-16.svg"
    sys_old = (STAGE2 / "symbol-16px.svg").read_text().replace("#C9CED4", "none").replace("#6E2366", "#16181D")
    old.write_text(sys_old)
    ours["Concept A 16 px (Stage 2)"] = rsvg(old, old.with_suffix(".png"), 16)
    scores = {o: {g: round(iou(ink_mask(p, "#FFFFFF"), ink_mask(gp, "#FFFFFF")), 2) for g, gp in glyphs.items()} for o, p in ours.items()}

    items = list(glyphs.items()) + [
        ("Stage 2 icon (rejected)", STAGE2 / "icon-light-16.png"),
        ("Slonview icon, light", DIRS["appicon"] / "icon-light-16.png"),
        ("Slonview icon, dark", DIRS["appicon"] / "icon-dark-16.png"),
        ("Slonview symbol, mono", DIRS["symbol"] / "symbol-16px-mono.png"),
    ]
    z, cell = 8, 16 * 8 + 24
    sheet = Image.new("RGB", (len(items) * cell + 24, 2 * (16 * z + 60) + 20), "#FFFFFF")
    for r, bgc in enumerate((FINDER_LIGHT, FINDER_DARK)):
        for i, (label, png) in enumerate(items):
            t = Image.new("RGBA", (16, 16), bgc)
            im = Image.open(png).convert("RGBA")
            if label.startswith("Slonview symbol") and r == 1:
                im = Image.open(DIRS["symbol"] / "symbol-16px-reversed.png").convert("RGBA")
            elif r == 1 and png.parent == tmp:
                im = Image.open(png).convert("RGBA")
                px = im.load()
                for y in range(16):
                    for x in range(16):
                        a = px[x, y][3]
                        px[x, y] = (230, 232, 236, a)
            t.alpha_composite(im)
            x0, y0 = 24 + i * cell, 20 + r * (16 * z + 60)
            sheet.paste(t.resize((16 * z, 16 * z), Image.NEAREST), (x0, y0))
            sheet.paste(t, (x0, y0 + 16 * z + 10))
            sheet.paste(t.resize((32, 32), Image.NEAREST), (x0 + 40, y0 + 16 * z + 2))
    sheet.save(DIRS["checks"] / "misread-16px.png")
    (DIRS["checks"] / "misread-16px-labels.json").write_text(json.dumps([l for l, _ in items], indent=1))
    shutil.rmtree(tmp)
    return scores


# ====================================================================== icon check sheet
def build_icon_sheet():
    rows = []
    for ap in ("light", "dark"):
        for bgc in (FINDER_LIGHT, FINDER_DARK):
            W = 256 * 3 + 128 + 64 + 32 + 16 + 40 * 7 + 256 + 128 + 60
            band = Image.new("RGB", (W, 300), bgc)
            x = 20
            for n in ICON_SIZES:
                im = Image.open(DIRS["appicon"] / f"icon-{ap}-{n}.png").convert("RGBA")
                if n > 256:
                    im = im.resize((256, 256), Image.LANCZOS)
                band.paste(im, (x, 22 + (256 - im.height) // 2), im)
                x += im.width + 40
            for n in (32, 16):
                t = Image.new("RGBA", (n, n), bgc)
                t.alpha_composite(Image.open(DIRS["appicon"] / f"icon-{ap}-{n}.png").convert("RGBA"))
                zz = 256 if n == 32 else 128
                band.paste(t.resize((zz, zz), Image.NEAREST), (x, 22 + (256 - zz) // 2))
                x += zz + 30
            rows.append(band)
    sheet = Image.new("RGB", (max(r.width for r in rows), 300 * len(rows)), "#FFFFFF")
    for i, r in enumerate(rows):
        sheet.paste(r, (0, i * 300))
    sheet.save(DIRS["checks"] / "appicon-sizes.png")
    # tuned versus straight downscale, 8x
    cmp_ = Image.new("RGB", (4 * 300 + 20, 300), "#FFFFFF")
    x = 10
    for ap in ("light", "dark"):
        for kind in ("icon-{ap}-16.png", "_downscaled-{ap}-16.png"):
            t = Image.new("RGBA", (16, 16), FINDER_LIGHT)
            t.alpha_composite(Image.open(DIRS["appicon"] / kind.format(ap=ap)).convert("RGBA"))
            cmp_.paste(t.resize((256, 256), Image.NEAREST), (x, 22))
            x += 300
    cmp_.save(DIRS["checks"] / "appicon-16-tuned-vs-downscaled.png")
    for ap in ("light", "dark"):
        for n in (16, 32):
            (DIRS["appicon"] / f"_downscaled-{ap}-{n}.png").unlink()


# ====================================================================== tokens
# (name, light, dark, role, replaces-light, replaces-dark). "Replaces" lists every current literal or class in src/
# (src/dev/** and the user-chosen PROFILE_COLORS excluded) that the token supersedes.
TOKENS = [
    ("accent", "#6E2366", "#D9A8FA", "Brand accent: primary buttons, links, active tab text, selected header fill, sort arrows, view/matview icons",
     "--accent #2563eb; bg-accent; text-accent; ResultGrid accent #2563eb", "--accent #5b8def; ResultGrid accent #5b8def"),
    ("accent-hover", "#5A1C54", "#C18DEC", "Hover/pressed accent fill (replaces filter: brightness(1.08)). Dark hover darkens, keeping protan ΔE ≥ 45 from red",
     ".btn-primary:hover filter: brightness(1.08)", "same"),
    ("accent-fg", "#FFFFFF", "#16181D", "Text and icons on accent fills. Dark theme flips to ink",
     "index.css:139 .btn-primary color #fff; TableTab:85 and ContextMenu:80 text-white / hover:text-white / focus-visible:text-white on bg-accent; ResultGrid accentFg #ffffff, textHeaderSelected #ffffff, and draw-callback literals at :269 (PK), :280 (column name), :303 (sort arrow) isSelected ? #ffffff",
     "same literals (white on lilac would be 1.92:1)"),
    ("accent-fg-muted", "#DBC8D9", "#473C54", "Secondary text on accent fills (type name on a selected header)",
     "ResultGrid:290 isSelected ? rgba(255,255,255,0.75); ContextMenu:83 shortcut opacity-60 on the highlighted (bg-accent) item", "same (75 % white on lilac would be 1.65:1; 60 % ink on lilac is 3.64:1)"),
    ("accent-soft", "#E4DCE6", "#3A3344", "Selected list item (sidebar relation, connection list); 3 px focus halo on fields",
     "--accent-soft rgba(37, 99, 235, 0.12): bg-accent-soft (Sidebar:172, ConnectionList:82), .field:focus box-shadow", "--accent-soft rgba(91, 141, 239, 0.18)"),
    ("ink", "#16181D", "#DFE2E7", "Primary text",
     "--fg #1c1f24; text-fg; ResultGrid text #1c1f24; text-neutral-900; text-neutral-800; hover:text-neutral-900; ResultsPanel text-red-900 (error panel body)",
     "--fg #dfe2e7; ResultGrid text #dfe2e7; dark:text-neutral-100; dark:text-neutral-200; dark:hover:text-neutral-100; dark:text-red-200 (error panel body)"),
    ("paper", "#FFFFFF", "#1B1D21", "App, grid and editor background",
     "--app #ffffff; bg-app; ResultGrid bg #ffffff; bg-white; SqlEditor bg-white", "--app #1b1d21; ResultGrid bg #1b1d21; dark:bg-neutral-950; SqlEditor dark:bg-[#282c34]"),
    ("raised", "#FFFFFF", "#2A2D33", "Dialogs, menus, toasts; ring offset", "--raised #ffffff; bg-raised; ring-offset-raised", "--raised #2a2d33"),
    ("surface", "#F4F5F8", "#212328", "Sidebar, toolbars, status bar, filter bar, editor gutter",
     "--side #f3f4f6; bg-side; bg-neutral-50", "--side #212328; dark:bg-neutral-900"),
    ("surface-2", "#EBEDF0", "#2E3137", "Hover fill, zebra rows, pressed toolbar buttons, splitter",
     "--hover #e8eaee; bg-hover; hover:bg-neutral-200; ResultGrid bgAlt #f6f7f9; bg-neutral-100; bg-neutral-200", "--hover #2e3137; ResultGrid bgAlt #202227; dark:bg-neutral-800; dark:hover:bg-neutral-800"),
    ("border", "#E1E4E8", "#33373E", "Dividers and panel edges (decorative, not a control boundary)",
     "--line #e1e4e8; border-line; bg-line; ResultGrid border #e3e5e9 (also bgHeaderHasFocus/Hovered); border-neutral-200", "--line #33373e; ResultGrid border #30343a; dark:border-neutral-800"),
    ("border-strong", "#7A818C", "#767D88", "Input, select and checkbox boundaries (≥ 3:1, WCAG 1.4.11)",
     ".field border var(--line) (1.3:1); border-neutral-300; border-faint (dashed colour swatch, ConnectionList dot ring)", "dark:border-neutral-700"),
    ("muted", "#4F5661", "#ADB3BD", "Secondary text, labels, icon buttons",
     "--muted #5e6570; text-muted; ResultGrid muted #5e6570; text-neutral-500; text-neutral-600; text-neutral-700; ContextMenu:83 shortcut opacity-60 (unhighlighted item); Sidebar:182 row-count text-faint when the row is active (on accent-soft)",
     "--muted #9198a3; ResultGrid muted #9198a3; dark:text-neutral-300; dark:text-neutral-400"),
    ("faint", "#636A75", "#969DA8", "Tertiary text: counts, type names, placeholders, WHERE label, search icons. Text-safe (≥ 4.5:1) everywhere except selection",
     "--faint #9aa1ab (2.61:1, fails); text-faint; bg-faint (status dot); ResultGrid faint #a0a6b0; text-neutral-400 and placeholder:text-neutral-400 (HistoryPanel:88, :95; 2.58:1, fails)",
     "--faint #626973 (3.04:1, fails); ResultGrid faint #5f6670"),
    ("selection", "#DFCFDD", "#493E55", "Selected cells / range fill (opaque so text contrast is checkable); editor text selection",
     "ResultGrid accentLight rgba(37, 99, 235, 0.14)", "ResultGrid accentLight rgba(91, 141, 239, 0.22); oneDark selection"),
    ("selection-fg-muted", "#4F5661", "#ADB3BD", "Any secondary text drawn on selection: NULL marker, faint text, PK marker, editor comments. faint, null-fg and warn are not allowed on selection",
     "ResultGrid nullTheme textDark (faint) when the cell is selected; PK marker on selection", "same"),
    ("row-highlight", "#F3EDF3", "#2E2B37", "Hovered or focused row, keyboard-focused history item, editor active line",
     "focus-visible:bg-blue-500/10; hover:bg-neutral-200/60", "dark:hover:bg-neutral-800/60; oneDark activeLine"),
    ("grid-header", "#F1F2F5", "#24272C", "Grid column header background", "ResultGrid header #f1f2f4", "ResultGrid header #24272c"),
    ("grid-header-fg", "#4F5661", "#ADB3BD", "Grid column header text (unselected)", "ResultGrid textHeader = muted #5e6570", "ResultGrid textHeader = muted #9198a3"),
    ("null-fg", "#636A75", "#969DA8", "NULL marker (italic) in unselected grid cells and the inspector. Switches to selection-fg-muted inside a selection",
     "ResultGrid nullTheme textDark = faint #a0a6b0; CellInspector:116 text-faint", "ResultGrid faint #5f6670"),
    ("focus-ring", "#6E2366", "#D9A8FA", "2 px focus outline on every control",
     ":focus-visible outline var(--accent); focus-visible:outline-blue-500 (HistoryPanel, ResultsPanel, SqlTab); focus-within:border-blue-500; ring-accent; .field:focus border-color", "same"),
    ("splitter-hover", "#6E2366", "#D9A8FA", "Hovered resize handle (1 px line at full accent)", "SqlTab:259 hover:bg-blue-500/40", "same"),
    ("readonly-fg", "#4F5661", "#ADB3BD", "READ-ONLY badge text (badge is outlined, no fill)", "Sidebar:63 READ-ONLY text-muted", "same"),
    ("readonly-border", "#7A818C", "#767D88", "READ-ONLY badge outline", "Sidebar:63 READ-ONLY border-line", "same"),
    ("write-bg", "#C62F3A", "#FF7B80", "WRITE badge fill. Red is reserved for WRITE and errors", "Sidebar:68, ConnectionList:89 bg-danger #d1343b", "bg-danger #f2656b"),
    ("write-fg", "#FFFFFF", "#16181D", "WRITE badge text", "Sidebar:68, ConnectionList:89 text-white", "text-white (3.07:1 on #f2656b, fails)"),
    ("error", "#C62F3A", "#FF8F94", "Error text, error icons, destructive button fill, SQL error underline, error panel border",
     "--danger #d1343b; text-danger; bg-danger (btn); border-danger/40; text-red-600; text-red-700; border-red-300; SqlEditor underline #ef4444",
     "--danger #f2656b; dark:text-red-300; dark:text-red-400; dark:border-red-900"),
    ("error-hover", "#A9262F", "#FFA9AD", "Hovered destructive button (replaces filter: brightness(1.08))", ".btn-danger:hover brightness(1.08)", "same"),
    ("error-fg", "#FFFFFF", "#16181D", "Text on error fills (destructive button). Dark flips to ink",
     "index.css:148 .btn-danger color #fff (Dialog:62 destructive confirm)", "same (white on #FF8F94 would be 2.19:1)"),
    ("error-soft", "#FAEEEF", "#32282D", "Error panel and error badge background; SQL error mark background",
     "--danger-soft rgba(209, 52, 59, 0.08); bg-danger-soft; bg-red-50; bg-red-100; SqlEditor rgba(239, 68, 68, 0.12)", "--danger-soft rgba(242, 101, 107, 0.1); dark:bg-red-950; dark:bg-red-950/50"),
    ("error-meta", "#4F5661", "#ADB3BD", "SQLSTATE and position lines inside an error panel (same value as muted)",
     "ResultsPanel:164, :169 text-red-700/80 (4.34:1 on red-50)", "dark:text-red-300/70"),
    ("ok", "#187A43", "#4CC38A", "Connected dot, success text", "--ok #1f8a4c; bg-ok; text-ok; text-emerald-600; text-emerald-700", "--ok #4cc38a; dark:text-emerald-400"),
    ("warn", "#94610F", "#E0B45C", "Warnings, connecting dot, PK marker in unselected grid headers",
     "--warn #b7791f (3.64:1, fails); text-warn; bg-warn; ResultGrid pk #b7791f; text-amber-700", "--warn #e0b45c; ResultGrid pk #e0b45c; dark:text-amber-400"),
    ("warn-soft", "#F4EFE7", "#373229", "PK badge background in the Structure tab", "StructureTab:88 bg-warn/15", "same"),
    ("scrim", "rgba(22, 24, 29, 0.32)", "rgba(0, 0, 0, 0.5)", "Modal backdrop (decorative; not contrast-checked)", "Dialog:31 backdrop:bg-black/30", "same"),
]

# CodeMirror theme spec (replaces oneDark in dark mode and the default light theme). All text ≥ 4.5:1 on
# editor-bg, editor-active-line and selection. Keywords use the brand accent; nothing in the editor is red
# except the SQL error mark.
EDITOR = [
    ("editor-bg", "#FFFFFF", "#1B1D21", "Editor background (= paper)", "SqlEditor bg-white", "oneDark #282c34; dark:bg-[#282c34]"),
    ("editor-fg", "#16181D", "#DFE2E7", "Default text, identifiers (= ink)", "CodeMirror default", "oneDark #abb2bf"),
    ("editor-gutter-bg", "#F4F5F8", "#212328", "Line-number gutter (= surface)", "CodeMirror default #f5f5f5", "oneDark #282c34"),
    ("editor-gutter-fg", "#636A75", "#969DA8", "Line numbers (= faint)", "CodeMirror default #6c6c6c", "oneDark #7d8799"),
    ("editor-gutter-active-fg", "#16181D", "#DFE2E7", "Active line number (= ink)", "CodeMirror default", "oneDark activeLineGutter"),
    ("editor-active-line", "#F3EDF3", "#2E2B37", "Active line (= row-highlight)", "CodeMirror default #cceeff44", "oneDark #2c313a"),
    ("editor-selection", "#DFCFDD", "#493E55", "Selection (= selection)", "CodeMirror default #d9d9d9", "oneDark #3E4451"),
    ("editor-cursor", "#6E2366", "#D9A8FA", "Cursor, 2 px (= accent)", "CodeMirror default black", "oneDark #528bff"),
    ("syntax-keyword", "#6E2366", "#D9A8FA", "SELECT, FROM, WHERE … (= accent)", "CodeMirror default #708", "oneDark #c678dd"),
    ("syntax-string", "#0550B3", "#7DB6FA", "String literals", "CodeMirror default #a11", "oneDark #98c379"),
    ("syntax-number", "#734A09", "#E0B45C", "Numeric literals", "CodeMirror default #164", "oneDark #d19a66"),
    ("syntax-comment", "#4F5661", "#ADB3BD", "Comments, italic (= muted; faint fails on selection)", "CodeMirror default #940", "oneDark #7d8799"),
    ("syntax-operator", "#2F343C", "#D0D4DA", "Operators and punctuation", "CodeMirror default", "oneDark #56b6c2"),
    ("editor-error-underline", "#C62F3A", "#FF8F94", "Wavy underline under the error position (= error)", "SqlEditor #ef4444", "same"),
    ("editor-error-bg", "#FAEEEF", "#32282D", "Background behind the error position (= error-soft)", "SqlEditor rgba(239, 68, 68, 0.12)", "same"),
]

TYPE_TOKENS = {
    "font-ui": "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif",
    "font-mono": "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
}


def build_tokens():
    def group(rows):
        return {n: {"light": l, "dark": dk, "role": role, "replaces": {"light": rl, "dark": rd}} for n, l, dk, role, rl, rd in rows}

    data = {
        "$description": "Slonview brand-to-UI tokens (Stage 3). Values are sRGB; light and dark follow prefers-color-scheme.",
        "color": group(TOKENS),
        "editor": group(EDITOR),
        "rules": [
            "On selection, secondary text (faint, null-fg, warn/PK) switches to selection-fg-muted.",
            "On accent-soft (selected list item), faint text (counts, type names) switches to muted.",
            "On accent fills, text uses accent-fg; secondary text uses accent-fg-muted.",
            "On error fills, text uses error-fg.",
            "Never lower text contrast with opacity or alpha (opacity-*, text-*/NN, inline opacity). Use muted, faint or accent-fg-muted. Disabled controls and show/hide toggles are the only exceptions.",
        ],
        "font": TYPE_TOKENS,
        "radius": {"control": "5px", "badge": "3px", "dialog": "10px"},
        "motion": {"mark-loop": "2s", "reduced-motion": "static mark"},
    }
    (ID / "tokens.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    rows = TOKENS + EDITOR
    w = max(len(t[0]) for t in rows)
    light = "\n".join(f"  --sv-{n}: {l};".ljust(w + 34) + f"/* {role} */" for n, l, _, role, _, _ in rows)
    dark = "\n".join(f"    --sv-{n}: {dk};" for n, _, dk, _, _, _ in rows)
    fonts = "\n".join(f"  --sv-{k}: {v};" for k, v in TYPE_TOKENS.items())
    css = f"""/* Slonview brand tokens (Stage 3). Generated by docs/brand/identity/build/build.py; edit there.
   Light is the default; dark follows the OS appearance, as the app does today.
   Rules: on selection, secondary text uses --sv-selection-fg-muted; on accent-soft, faint text uses
   --sv-muted; on accent fills, --sv-accent-fg (secondary: --sv-accent-fg-muted); on error fills,
   --sv-error-fg. Never reduce text contrast with opacity or alpha; disabled controls are the only exception. */
:root {{
{light}
{fonts}
  --sv-radius-control: 5px;
  --sv-radius-badge: 3px;
  --sv-radius-dialog: 10px;
}}

@media (prefers-color-scheme: dark) {{
  :root {{
{dark}
  }}
}}
"""
    (ID / "tokens.css").write_text(css)


# ====================================================================== contrast + dE report
def build_contrast():
    T = {n: (l, dk) for n, l, dk, *_ in TOKENS + EDITOR}
    rows = []

    def add(theme, label, fg, bg, need, kind):
        r = C.contrast(fg, bg)
        rows.append({"theme": theme, "pair": label, "fg": fg, "bg": bg, "ratio": round(r, 2), "min": need, "kind": kind, "pass": r >= need})

    for i, theme in enumerate(("light", "dark")):
        g = lambda n: T[n][i]  # noqa: E731
        grounds = ["paper", "surface", "surface-2", "raised", "grid-header"]
        for fgn in ("ink", "muted", "faint", "accent", "error", "ok", "warn"):
            for bgn in grounds:
                if theme == "light" and bgn == "raised":
                    continue
                add(theme, f"{fgn} on {bgn}", g(fgn), g(bgn), 4.5, "text")
        add(theme, "ink on selection", g("ink"), g("selection"), 4.5, "text")
        add(theme, "selection-fg-muted (NULL, faint, PK) on selection", g("selection-fg-muted"), g("selection"), 4.5, "text")
        add(theme, "accent (sort arrow, link) on selection", g("accent"), g("selection"), 4.5, "text")
        add(theme, "accent-fg-muted (type name on selected header; shortcut on highlighted menu item) on accent", g("accent-fg-muted"), g("accent"), 4.5, "text")
        add(theme, "ink on accent-soft (selected list item)", g("ink"), g("accent-soft"), 4.5, "text")
        add(theme, "muted on accent-soft (row count, type name on the selected sidebar row)", g("muted"), g("accent-soft"), 4.5, "text")
        add(theme, "accent (view icon) on accent-soft", g("accent"), g("accent-soft"), 3.0, "non-text")
        add(theme, "muted (menu shortcut) on raised", g("muted"), g("raised"), 4.5, "text")
        add(theme, "error-fg on error (destructive button)", g("error-fg"), g("error"), 4.5, "text")
        add(theme, "error-fg on error-hover", g("error-fg"), g("error-hover"), 4.5, "text")
        add(theme, "ink on error-soft (error panel body)", g("ink"), g("error-soft"), 4.5, "text")
        add(theme, "error-meta on error-soft (SQLSTATE line)", g("error-meta"), g("error-soft"), 4.5, "text")
        add(theme, "warn on warn-soft (PK badge)", g("warn"), g("warn-soft"), 4.5, "text")
        add(theme, "faint (placeholder, search icon) on paper", g("faint"), g("paper"), 4.5, "text")
        for fgn in ("editor-fg", "editor-gutter-fg", "editor-gutter-active-fg", "editor-cursor", "syntax-keyword", "syntax-string", "syntax-number", "syntax-comment", "syntax-operator"):
            bgs = ("editor-gutter-bg",) if fgn.startswith("editor-gutter") else ("editor-bg", "editor-active-line", "editor-selection")
            for bgn in bgs:
                need = 3.0 if fgn == "editor-cursor" else 4.5
                add(theme, f"{fgn} on {bgn}", g(fgn), g(bgn), need, "non-text" if need == 3.0 else "text")
        add(theme, "editor-error-underline on editor-error-bg", g("editor-error-underline"), g("editor-error-bg"), 3.0, "non-text")
        add(theme, "ink on row-highlight", g("ink"), g("row-highlight"), 4.5, "text")
        add(theme, "muted on row-highlight", g("muted"), g("row-highlight"), 4.5, "text")
        add(theme, "accent-fg on accent", g("accent-fg"), g("accent"), 4.5, "text")
        add(theme, "accent-fg on accent-hover", g("accent-fg"), g("accent-hover"), 4.5, "text")
        add(theme, "accent-hover on paper (hovered link)", g("accent-hover"), g("paper"), 4.5, "text")
        add(theme, "write-fg on write-bg (WRITE badge)", g("write-fg"), g("write-bg"), 4.5, "text")
        add(theme, "readonly-fg on surface (READ-ONLY badge)", g("readonly-fg"), g("surface"), 4.5, "text")
        add(theme, "grid-header-fg on grid-header", g("grid-header-fg"), g("grid-header"), 4.5, "text")
        add(theme, "null-fg on paper", g("null-fg"), g("paper"), 4.5, "text")
        add(theme, "null-fg on surface-2 (zebra)", g("null-fg"), g("surface-2"), 4.5, "text")
        add(theme, "error on error-soft", g("error"), g("error-soft"), 4.5, "text")
        add(theme, "warn (PK) on grid-header", g("warn"), g("grid-header"), 4.5, "text")
        add(theme, "accent (sort arrow) on grid-header", g("accent"), g("grid-header"), 4.5, "text")
        for bgn in ("paper", "surface", "surface-2"):
            add(theme, f"focus-ring on {bgn}", g("focus-ring"), g(bgn), 3.0, "non-text")
            add(theme, f"border-strong on {bgn}", g("border-strong"), g(bgn), 3.0, "non-text")
        add(theme, "readonly-border on surface", g("readonly-border"), g("surface"), 3.0, "non-text")
        add(theme, "write-bg on surface (badge shape)", g("write-bg"), g("surface"), 3.0, "non-text")
    # brand mark pairings
    for mode, ground in (("light", BRAND["paper"]), ("light", "#FFFFFF"), ("dark", BRAND["graphite_deep"]), ("dark", "#212328")):
        cols = SYMBOL_COLOURS[mode]
        for part in ("frame", "quiet", "row"):
            add(f"mark {mode}", f"symbol {part} on {ground}", cols[part], ground, 3.0, "non-text")
    for ap in ("light", "dark"):
        sc = ICON[ap]
        for tile in (sc["tile"], sc["tile2"]):
            for part in ("frame", "quiet", "row"):
                add(f"icon {ap}", f"{part} on tile {tile}", sc[part], tile, 3.0, "non-text")
    add("mark", "wordmark ink on paper", BRAND["ink"], BRAND["paper"], 4.5, "text")
    add("mark", "wordmark (dark) paper on graphite", BRAND["paper"], BRAND["graphite_deep"], 4.5, "text")
    add("mark", "reversed white on plum", "#FFFFFF", BRAND["plum"], 4.5, "text")
    add("readme dark", "#ADB3BD sub-line on graphite", "#ADB3BD", BRAND["graphite_deep"], 4.5, "text")
    add("readme light", "#4F5661 number line on paper", "#4F5661", BRAND["paper"], 4.5, "text")

    acc_d, acc_l = BRAND["lilac"], BRAND["plum"]
    de = []
    for a, b, label in (
        (acc_d, FUNCTIONAL["write_dark"], "accent dark vs WRITE dark"),
        (acc_d, FUNCTIONAL["error_dark"], "accent dark vs error dark"),
        ("#E2A6D9", FUNCTIONAL["write_dark"], "Stage 2 accent dark #E2A6D9 vs WRITE dark (before)"),
        ("#E2A6D9", FUNCTIONAL["error_dark"], "Stage 2 accent dark #E2A6D9 vs error dark (before)"),
        (acc_l, FUNCTIONAL["write_light"], "accent light vs WRITE light"),
        (T["accent-hover"][0], T["write-bg"][0], "accent-hover light vs WRITE light"),
        (T["accent-hover"][1], T["write-bg"][1], "accent-hover dark vs WRITE dark"),
        (T["accent-hover"][1], T["error"][1], "accent-hover dark vs error dark"),
        ("#E6C3FC", T["error"][1], "Stage 3 r1 accent-hover dark #E6C3FC vs error dark (before)"),
        (T["selection"][1], T["write-bg"][1], "selection dark vs WRITE dark"),
        (T["selection"][0], T["write-bg"][0], "selection light vs WRITE light"),
        (T["syntax-keyword"][1], T["error"][1], "syntax keyword dark vs error dark"),
        (T["syntax-number"][1], T["error"][1], "syntax number dark vs error dark"),
        (T["syntax-string"][0], T["error"][0], "syntax string light vs error light"),
        (acc_d, "#6366F1", "accent dark vs indigo #6366F1 (avoid list)"),
        (acc_d, "#FFB6D9", "accent dark vs Harlequin pink #FFB6D9 (avoid list)"),
        (acc_l, "#4F46E5", "accent light vs indigo #4F46E5 (avoid list)"),
    ):
        de.append({
            "pair": label, "a": a, "b": b,
            "dE76": round(C.delta_e(a, b), 1), "protan": round(C.delta_e(a, b, "protan"), 1),
            "deutan": round(C.delta_e(a, b, "deutan"), 1), "hue_gap": round(C.hue_gap(a, b), 1),
        })
    # Combinations the rules forbid. Computed so the table shows why the rule exists; they are not counted.
    forbidden = []
    for i, theme in enumerate(("light", "dark")):
        for fgn in ("faint", "null-fg", "warn"):
            fg, bg = T[fgn][i], T["selection"][i]
            forbidden.append({"theme": theme, "pair": f"{fgn} on selection (forbidden; use selection-fg-muted)", "fg": fg, "bg": bg, "ratio": round(C.contrast(fg, bg), 2)})
        forbidden.append({"theme": theme, "pair": "white on error (forbidden in dark; use error-fg)", "fg": "#FFFFFF", "bg": T["error"][i], "ratio": round(C.contrast("#FFFFFF", T["error"][i]), 2)})
        fg = T["faint"][i]
        forbidden.append({"theme": theme, "pair": "faint on accent-soft (forbidden; use muted)", "fg": fg, "bg": T["accent-soft"][i], "ratio": round(C.contrast(fg, T["accent-soft"][i]), 2)})
        ink60 = C.blend(T["accent-fg"][i], T["accent"][i], 0.6)
        forbidden.append({"theme": theme, "pair": "accent-fg at 60 % opacity on accent (forbidden; use accent-fg-muted)", "fg": ink60, "bg": T["accent"][i], "ratio": round(C.contrast(ink60, T["accent"][i]), 2)})
        forbidden.append({"theme": theme, "pair": "white on accent (forbidden in dark; use accent-fg)", "fg": "#FFFFFF", "bg": T["accent"][i], "ratio": round(C.contrast("#FFFFFF", T["accent"][i]), 2)})
    summary = {"total": len(rows), "pass": sum(r["pass"] for r in rows), "fail": sum(not r["pass"] for r in rows)}
    (DIRS["checks"] / "contrast.json").write_text(json.dumps({"summary": summary, "contrast": rows, "forbidden": forbidden, "delta_e": de}, indent=2) + "\n")
    lines = [f"**{summary['pass']} of {summary['total']} required pairings pass.**", "", "| Theme | Pairing | FG | BG | Ratio | Min | Result |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['theme']} | {r['pair']} | `{r['fg']}` | `{r['bg']}` | {r['ratio']:.2f} | {r['min']} | {'pass' if r['pass'] else '**FAIL**'} |")
    lines += ["", "Forbidden combinations (the token rules route around these; not counted above):", "", "| Theme | Pairing | FG | BG | Ratio |", "|---|---|---|---|---|"]
    for r in forbidden:
        lines.append(f"| {r['theme']} | {r['pair']} | `{r['fg']}` | `{r['bg']}` | {r['ratio']:.2f} |")
    lines += ["", "| Pair | A | B | ΔE76 | Protan ΔE | Deutan ΔE | Hue gap |", "|---|---|---|---|---|---|---|"]
    for r in de:
        lines.append(f"| {r['pair']} | `{r['a']}` | `{r['b']}` | {r['dE76']} | {r['protan']} | {r['deutan']} | {r['hue_gap']}° |")
    (DIRS["checks"] / "contrast-table.md").write_text("\n".join(lines) + "\n")
    return [r for r in rows if not r["pass"]], de, summary, forbidden


# ====================================================================== misuse examples
def build_misuse():
    """Eight misuse tiles, each a deliberately wrong application of the real mark."""
    p = symbol64()
    L = SYMBOL_COLOURS["light"]

    def sym(cols, tf=""):
        return f'<g transform="{tf}">' + "".join(f'<path fill="{cols[k]}" d="{d(p[k])}"/>' for k in ("frame", "quiet", "row")) + "</g>"

    open_wall = diff(rrect(4, 12, 44, 40, 9), rrect(9.5, 17.5, 33, 29, 5.15), rect(41, 18, 8, 28))
    cases = [
        ("Red row", sym(dict(L, row=FUNCTIONAL["write_light"]))),
        ("Old UI blue", sym(dict(L, row="#2563EB"))),
        ("Squashed", sym(L, "translate(0,9.6) scale(1,0.7)")),
        ("Rotated", sym(L, "rotate(-14 32 32)")),
        ("Wall opened", f'<path fill="{L["frame"]}" d="{d(open_wall)}"/><path fill="{L["quiet"]}" d="{d(p["quiet"])}"/><path fill="{L["row"]}" d="{d(p["row"])}"/>'),
        ("Speed lines", sym(L) + "".join(f'<rect x="{x}" y="{y}" width="9" height="1.6" rx=".8" fill="{L["row"]}"/>' for x, y in ((52, 22), (55, 25), (52, 41)))),
        ("Baked shadow", f'<g opacity=".3" transform="translate(2,3)">{sym({"frame": "#000", "quiet": "#000", "row": "#000"})}</g>' + sym(L)),
        ("Low-contrast ground", '<rect x="-8" y="-8" width="80" height="80" fill="#2A2D33"/>' + sym(L)),
    ]
    cell, pad = 220, 20
    W, H = 4 * cell, 2 * (cell + 40)
    body = [f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>']
    for i, (label, inner) in enumerate(cases):
        cx, cy = (i % 4) * cell, (i // 4) * (cell + 40)
        body.append(f'<rect x="{cx + 10}" y="{cy + 10}" width="{cell - 20}" height="{cell - 20}" rx="10" fill="{BRAND["paper"]}"/>')
        body.append(f'<svg x="{cx + pad + 10}" y="{cy + pad + 10}" width="{cell - 2 * pad - 20}" height="{cell - 2 * pad - 20}" viewBox="0 0 64 64">{inner}</svg>')
        body.append(f'<path d="M{cx + cell - 44} {cy + 22}l16 16m0 -16l-16 16" stroke="{FUNCTIONAL["write_light"]}" stroke-width="3" stroke-linecap="round"/>')
        t, _ = text_svg(f"{i + 1}. {label}", "hanken", 560, 15, cx + 14, cy + cell + 16, BRAND["ink"])
        body.append(t)
    f = write(DIRS["checks"] / "misuse.svg", svg_doc(W, H, "".join(body), "Slonview mark misuse examples"))
    rsvg(f, f.with_suffix(".png"), W, H)


# ====================================================================== integrity check
def audit_vectors():
    bad = []
    for f in ID.rglob("*.svg"):
        if "build" in f.parts or f.name == "wordmark-editable.svg":
            continue
        s = f.read_text()
        for needle in ("<text", "<image", "data:image", "font-family", "feDropShadow", "<filter"):
            if needle in s:
                bad.append((str(f.relative_to(ID)), needle))
    return bad


# ====================================================================== token-map coverage of src/
COLOUR_RE = re.compile(
    r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oneDark"
    r"|(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|outline|placeholder:text|backdrop:bg|ring-offset)"
    r"-(?:white|black|[a-z]+-[0-9]{2,3}|\[#[0-9a-fA-F]+\]|app|side|raised|hover|line|fg|muted|faint|accent|accent-soft|danger|danger-soft|ok|warn)(?:/[0-9]+)?(?![\w-])"
)
# Not brand colours: user-chosen connection dots (and the doc comment that cites one).
COVERAGE_EXCLUDE = {"#3b82f6", "#22a06b", "#e5484d", "#f59e0b", "#8e4ec6", "#0ea5a4", "#6b7280"}


def _norm(s):
    return re.sub(r"\s+", "", s.lower())


def audit_coverage():
    """Every colour literal or colour class in src/ must be named in some token's 'replaces' text.
    A class matches if its full form, its form without state prefixes (dark:, hover:) or its form
    without an opacity suffix appears there. Hex is matched case-insensitively."""
    mapped = _norm(" ".join(f"{rl} {rd}" for *_, rl, rd in TOKENS + EDITOR))
    found = {}
    for f in sorted((REPO / "src").rglob("*")):
        rel = f.relative_to(REPO / "src")
        if f.suffix not in (".ts", ".tsx", ".css") or rel.parts[0] in ("dev", "bindings"):
            continue
        for n, line in enumerate(f.read_text().splitlines(), 1):
            for m in COLOUR_RE.findall(line):
                if m.lower() not in COVERAGE_EXCLUDE:
                    found.setdefault(m, []).append(f"src/{rel}:{n}")
    missing = []
    for m in sorted(found):
        base = re.sub(r"^(?:[a-z-]+:)+(?=(?:bg|text|border|ring|outline)-)", "", m)
        probes = {_norm(m), _norm(base), _norm(re.sub(r"/[0-9]+$", "", base))}
        if not any(p in mapped for p in probes):
            missing.append(m)
    rows = [{"literal": m, "where": found[m], "mapped": m not in missing} for m in sorted(found)]
    alpha = audit_alpha_text(mapped)
    (DIRS["checks"] / "src-colour-coverage.json").write_text(json.dumps({
        "total": len(rows), "unmapped": missing, "literals": rows,
        "alpha_text": alpha, "alpha_text_unmapped": [a for a in alpha if a["status"] == "UNMAPPED"],
    }, indent=2) + "\n")
    return len(rows), missing, alpha


# Opacity-based text lowers contrast invisibly to a colour grep. Flag every occurrence:
#   opacity-NN classes, text-*/NN alpha colour classes, inline `opacity` in style objects and CSS.
ALPHA_RE = re.compile(
    r"(?<![\w-])((?:[a-z-]+:)*opacity-\d+)(?![\w-])"
    r"|(?<![\w-])((?:[a-z-]+:)*text-[a-z]+(?:-\d{2,3})?/\d+)(?![\w-])"
    r"|(\bopacity\s*:\s*[0-9.]+)"
)


def audit_alpha_text(mapped):
    """Each hit is 'mapped' (its class or File:line is named in a token's replaces text),
    'exempt' (disabled state or a 0/100 show-hide toggle, which carries no text contrast),
    or 'UNMAPPED' (fails the build report)."""
    out = []
    for f in sorted((REPO / "src").rglob("*")):
        rel = f.relative_to(REPO / "src")
        if f.suffix not in (".ts", ".tsx", ".css") or rel.parts[0] in ("dev", "bindings"):
            continue
        lines = f.read_text().splitlines()
        selector = ""
        for n, line in enumerate(lines, 1):
            if f.suffix == ".css" and "{" in line:
                selector = line
            for m in ALPHA_RE.finditer(line):
                hit = next(g for g in m.groups() if g)
                loc = f"{f.stem}:{n}"
                if re.match(r"(?:[a-z-]+:)*disabled:", hit) or ":disabled" in selector and hit.startswith("opacity"):
                    status = "exempt (disabled state)"
                elif re.search(r"opacity-(0|100)$", hit):
                    status = "exempt (show/hide toggle)"
                elif _norm(loc) in mapped or _norm(hit) in mapped:
                    status = "mapped"
                else:
                    status = "UNMAPPED"
                out.append({"where": f"src/{rel}:{n}", "hit": hit, "status": status})
    return out


def main():
    build_symbol()
    build_wordmark()
    build_lockup()
    build_appicon()
    build_favicon()
    nadv = build_readme()
    fadv = build_social()
    build_motion()
    build_misuse()
    scores = build_misread()
    build_icon_sheet()
    build_tokens()
    fails, de, summary, forbidden = build_contrast()
    total, unmapped, alpha = audit_coverage()
    print("contrast summary:", summary, "| forbidden:", [(f["theme"], f["pair"], f["ratio"]) for f in forbidden])
    print("src colour coverage:", total, "literals; unmapped:", unmapped)
    print("alpha/opacity text:", [(a["where"], a["hit"], a["status"]) for a in alpha])
    (DIRS["checks"] / "misread-iou.json").write_text(json.dumps(scores, indent=2, ensure_ascii=False) + "\n")
    print("readme number line width", round(nadv), "| card footer width", round(fadv))
    print("misread IoU:", json.dumps(scores, indent=1, ensure_ascii=False))
    print("contrast fails:", [(f["theme"], f["pair"], f["ratio"]) for f in fails])
    for r in de:
        print("dE", r)
    print("vector audit:", audit_vectors() or "clean")


if __name__ == "__main__":
    main()
