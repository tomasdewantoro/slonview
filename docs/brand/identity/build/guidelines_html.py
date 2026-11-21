"""Render docs/brand/slonview-brand-guidelines.md to a self-contained, on-brand HTML page.

Run after build.py:  python3 guidelines_html.py
- Fonts: Hanken Grotesk and JetBrains Mono embedded as base64 @font-face (SIL OFL 1.1 permits embedding).
- Figures: `<!-- fig:NAME -->` markers in the Markdown are replaced with inline SVG/PNG data URIs.
- No network URL anywhere in the output; the script asserts this.
Handles the Markdown subset the guidelines use: headings, paragraphs, nested lists, tables, fenced code,
inline code, bold, italic, horizontal rules.
"""
import base64
import html
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
ID = HERE.parent
BRAND = ID.parent
SRC = BRAND / "slonview-brand-guidelines.md"
OUT = BRAND / "slonview-brand-guidelines.html"


def b64(path):
    return base64.b64encode(path.read_bytes()).decode()


def data_uri(path):
    mime = {".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf"}[path.suffix]
    return f"data:{mime};base64,{b64(path)}"


def img(rel, alt, cls="", width=None):
    w = f' width="{width}"' if width else ""
    c = f' class="{cls}"' if cls else ""
    return f'<img src="{data_uri(ID / rel)}" alt="{html.escape(alt)}"{c}{w} loading="lazy" decoding="async">'


# ---------------------------------------------------------------- figures
def fig(body, caption, cls=""):
    return f'<figure class="fig {cls}">{body}<figcaption>{caption}</figcaption></figure>'


def tile(inner, ground, label):
    return f'<div class="tile" style="background:{ground}">{inner}<span class="tile-label">{label}</span></div>'


GROUNDS = {"light": "#F4F5F8", "dark": "#1B1D21", "mono": "#FFFFFF", "reversed": "#6E2366"}
LABEL_ON = {"light": "#4F5661", "dark": "#ADB3BD", "mono": "#4F5661", "reversed": "#FFFFFF"}


def fig_hero():
    return (
        '<div class="hero">'
        f'<div class="hero-mark">{img("symbol/symbol-light.svg", "Slonview symbol", width=200)}</div>'
        f'<div class="hero-motion">{img("motion/symbol-motion-light.svg", "Slonview symbol, 2 s motion loop (static when reduced motion is requested)", width=200)}'
        '<span class="cap">2 s loop · static under reduced motion</span></div>'
        "</div>"
    )


def fig_marks():
    rows = []
    for mode in ("light", "dark", "mono", "reversed"):
        cells = [
            img(f"symbol/symbol-{mode}.svg", f"Symbol, {mode}", width=96),
            img(f"lockup/lockup-horizontal-{mode}.svg", f"Horizontal lockup, {mode}", "lockup"),
        ]
        rows.append(
            f'<div class="markrow" style="background:{GROUNDS[mode]};color:{LABEL_ON[mode]}">'
            + "".join(f"<div>{c}</div>" for c in cells)
            + f'<span class="tile-label" style="color:{LABEL_ON[mode]}">{mode} · {GROUNDS[mode]}</span></div>'
        )
    wm = "".join(
        f'<div class="tile" style="background:{GROUNDS[m]}">{img(f"wordmark/wordmark-{m}.svg", f"Wordmark, {m}", "wm")}</div>'
        for m in ("light", "dark")
    )
    return fig("".join(rows) + f'<div class="tiles two">{wm}</div>', "Symbol and horizontal lockup in the four colourways, and the outlined wordmark. Outlined SVG masters, rendered by the browser.")


def fig_clearspace():
    # lockup with 3R guides; R = 8/64 of symbol height. Lockup SVG is 560x128, symbol height 108.04 px at 1x.
    sym_h = 108.04
    r = sym_h * 8 / 64
    pad = 3 * r
    w, h = 560 + 2 * pad, 128 + 2 * pad
    lock = (ID / "lockup" / "lockup-horizontal-light.svg").read_text()
    lock = re.sub(r"<title>.*?</title>", "", lock)
    inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", lock.strip())
    guides = (
        f'<rect x="0" y="0" width="{w:.1f}" height="{h:.1f}" fill="#F4F5F8"/>'
        f'<rect x="{pad:.1f}" y="{pad:.1f}" width="560" height="128" fill="none" stroke="#6E2366" stroke-dasharray="6 5" stroke-width="1.5"/>'
        f'<rect x="0" y="0" width="{w:.1f}" height="{h:.1f}" fill="none" stroke="#7A818C" stroke-width="1"/>'
    )
    for x, y, ww, hh in ((0, h / 2 - r / 2, pad, r), (w - pad, h / 2 - r / 2, pad, r), (w / 2 - r / 2, 0, r, pad), (w / 2 - r / 2, h - pad, r, pad)):
        guides += f'<rect x="{x:.1f}" y="{y:.1f}" width="{ww:.1f}" height="{hh:.1f}" fill="#D9A8FA" opacity=".7"/>'
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.1f} {h:.1f}" role="img" aria-label="Clearspace: 3R on every side">{guides}<g transform="translate({pad:.1f},{pad:.1f})">{inner}</g></svg>'
    return fig(f'<div class="svgwrap">{svg}</div>', "Clearspace. The lilac blocks are 3R deep, where R is the height of the accent row (8/64 of the symbol). Nothing enters the outer box.")


def fig_small():
    cells = []
    for n in (32, 16):
        for mode in ("light", "dark", "mono", "reversed"):
            inner = (
                f'{img(f"symbol/symbol-{n}px-{mode}.svg", f"{n} px master, {mode}", width=n)}'
                f'{img(f"symbol/symbol-{n}px-{mode}.png", f"{n} px master, {mode}, 4×", "px", width=n * 4)}'
            )
            cells.append(tile(inner, GROUNDS[mode], f"{n} px · {mode}"))
    return fig(f'<div class="tiles four">{"".join(cells)}</div>', "Hand-tuned 32 and 16 px masters, at 1:1 and at 4× (nearest-neighbour).")


def fig_png(rel, caption, alt, cls=""):
    return fig(f'<div class="scroll">{img(rel, alt, cls)}</div>', caption)


def fig_swatches():
    contrast = json.loads((ID / "checks" / "contrast.json").read_text())
    from colour import contrast as cr  # local module

    sw = [
        ("Plum", "#6E2366", "Accent, light"), ("Plum deep", "#5A1C54", "Hover, light"), ("Plum tile", "#7A2A71", "Icon tile"),
        ("Lilac", "#D9A8FA", "Accent, dark"), ("Lilac deep", "#C18DEC", "Hover, dark"), ("Ink", "#16181D", "Text, frame"),
        ("Paper", "#F4F5F8", "Light ground"), ("Graphite", "#1B1D21", "Dark ground"), ("Fog", "#DFE2E7", "Text on dark"),
        ("Quiet light", "#868D98", "Quiet rows, light"), ("Quiet dark", "#767D88", "Quiet rows, dark"),
        ("WRITE / error", "#C62F3A", "Light, functional"), ("WRITE dark", "#FF7B80", "Dark, functional"), ("Error dark", "#FF8F94", "Dark, functional"),
    ]
    cards = []
    for name, hx, role in sw:
        on_w, on_i = cr(hx, "#FFFFFF"), cr(hx, "#16181D")
        fg = "#FFFFFF" if on_w >= on_i else "#16181D"
        best = max(on_w, on_i)
        cards.append(
            f'<div class="swatch"><div class="chip" style="background:{hx};color:{fg}"><span class="mono">{best:.2f}:1</span></div>'
            f'<div class="sw-meta"><b>{name}</b><span class="mono">{hx}</span><span class="sw-role">{role}</span>'
            f'<span class="mono sw-ratio">on paper {cr(hx, "#F4F5F8"):.2f} · on graphite {cr(hx, "#1B1D21"):.2f}</span></div></div>'
        )
    s = contrast["summary"]
    return fig(f'<div class="swatches">{"".join(cards)}</div>', f"Palette with WCAG contrast. The chip label shows the best of white or ink text on that colour. {s['pass']} of {s['total']} required token pairings pass (§6.4).")


def fig_type():
    return fig(
        '<div class="type">'
        '<div class="t-row"><span class="t-tag">Display · Hanken Grotesk 680 · 48/52</span><p class="t-display">About 8 MB. A million rows to CSV in 0.44 s.</p></div>'
        '<div class="t-row"><span class="t-tag">UI · Hanken Grotesk 400 / 500 / 600 · 13 px</span><p class="t-ui">Look first. Write on purpose. <b>Allow writes</b> · <span class="badge ro">READ-ONLY</span> <span class="badge w">WRITE</span></p></div>'
        '<div class="t-row"><span class="t-tag">Data · JetBrains Mono 400 / 600 · 12 px · tabular</span>'
        '<pre class="t-mono"><span class="k">SELECT</span> id, amount <span class="k">FROM</span> orders <span class="k">WHERE</span> status = <span class="s">\'paid\'</span> <span class="k">LIMIT</span> <span class="n">501</span>;\n'
        '      1   79.19   2024-01-01 00:00:01+00\n     10  791.90   <i class="null">NULL</i></pre></div>'
        "</div>",
        "Type specimen, set live in the embedded fonts. Badges use the WRITE and READ-ONLY tokens.",
    )


def fig_applications():
    return fig(
        f'<div class="apps">{img("readme/readme-header-light.svg", "README header, light: About 8 MB. Ready for a million rows. 1,000,000-row CSV export in ~0.44 s, local benchmark: PostgreSQL 18.4, Unix socket, MacBook Air (Mac17,3, Apple M5). Look first. Write on purpose.")}'
        f'{img("readme/readme-header-dark.svg", "README header, dark")}'
        f'{img("social/social-card.svg", "GitHub social card: About 8 MB. A million rows to CSV in 0.44 s. Local benchmark: 1,000,000-row orders table, PostgreSQL 18.4 over Unix socket, MacBook Air (Mac17,3, Apple M5).")}</div>',
        "README header (light and dark, 1280 × 320) and GitHub social card (1280 × 640). All text is outlined.",
    )


FIGS = {
    "hero": fig_hero,
    "marks": fig_marks,
    "clearspace": fig_clearspace,
    "small": fig_small,
    "misuse": lambda: fig_png("checks/misuse.png", "Eight misuses. Each tile is the real mark, deliberately broken.", "Misuse examples sheet"),
    "iconsizes": lambda: fig_png("checks/appicon-sizes.png", "App icon at 1024 → 16 px (1024 and 512 shown at 256), light and dark appearances, on Finder light and dark. Right: tuned 32 and 16 px at 8×.", "App icon size sheet"),
    "dock": lambda: fig_png("checks/render-dock.png", "Dock simulation, light and dark desktop, both icon appearances. Rendered in headless Chromium.", "Dock render"),
    "misread": lambda: fig_png("checks/misread-16px.png", "16 px misread sheet: Lucide log-out, square-arrow-right-exit, battery, app-window, menu, scrollbar, progress bar, “C” and “€”, then the rejected Stage 2 icon and the Stage 3 icon (light, dark, mono). 8× above, 1:1 below.", "Misread sheet", "px"),
    "swatches": fig_swatches,
    "type": fig_type,
    "applications": fig_applications,
}


# ---------------------------------------------------------------- markdown subset
def slug(s):
    s = re.sub(r"<[^>]+>|`", "", s).lower()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    return re.sub(r"\s+", "-", s.strip())


def inline(s):
    codes = []
    s = re.sub(r"`([^`]+)`", lambda m: f"\0{codes.append(m.group(1)) or len(codes) - 1}\0", s)
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", s)
    return re.sub(r"\0(\d+)\0", lambda m: f"<code>{html.escape(codes[int(m.group(1))])}</code>", s)


def render(md):
    lines = md.splitlines()
    out, toc = [], []
    i = 0
    title = ""
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = re.match(r"<!-- fig:(\w+) -->", line.strip())
        if m:
            out.append(FIGS[m.group(1)]())
            i += 1
            continue
        m = re.match(r"(#{1,4})\s+(.*)", line)
        if m:
            lvl, text = len(m.group(1)), m.group(2)
            if lvl == 1:
                title = text
                i += 1
                continue
            sid = slug(text)
            if lvl == 2:
                toc.append((sid, re.sub(r"`", "", text)))
            out.append(f'<h{lvl} id="{sid}">{inline(text)}</h{lvl}>')
            i += 1
            continue
        if re.match(r"^---+\s*$", line):
            out.append("<hr>")
            i += 1
            continue
        if line.startswith("```"):
            lang = line[3:].strip()
            body = []
            i += 1
            while not lines[i].startswith("```"):
                body.append(lines[i])
                i += 1
            i += 1
            out.append(f'<pre class="code" data-lang="{lang}"><code>{html.escape(chr(10).join(body))}</code></pre>')
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1]):
            head = [c.strip() for c in line.strip("|").split("|")]
            i += 2
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            trs = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows)
            out.append(f'<div class="table-wrap"><table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table></div>')
            continue
        if re.match(r"^\s*(?:[-*]|\d+\.)\s", line):
            block = []
            while i < len(lines) and (re.match(r"^\s*(?:[-*]|\d+\.)\s", lines[i]) or (lines[i].startswith("  ") and lines[i].strip())):
                block.append(lines[i])
                i += 1
            out.append(render_list(block))
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|\||```|<!-- fig|\s*(?:[-*]|\d+\.)\s|---)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{inline(' '.join(para))}</p>")
    return title, toc, "\n".join(out)


def render_list(block):
    def parse(items, depth):
        html_items, j = [], 0
        ordered = bool(re.match(r"^\s*\d+\.", items[0]))
        while j < len(items):
            m = re.match(r"^(\s*)(?:[-*]|\d+\.)\s+(.*)", items[j])
            text = m.group(2)
            j += 1
            child = []
            while j < len(items) and len(re.match(r"^(\s*)", items[j]).group(1)) > depth:
                child.append(items[j])
                j += 1
            sub = parse(child, len(re.match(r"^(\s*)", child[0]).group(1))) if child else ""
            html_items.append(f"<li>{inline(text)}{sub}</li>")
        tag = "ol" if ordered else "ul"
        return f"<{tag}>{''.join(html_items)}</{tag}>"

    return parse(block, 0)


# ---------------------------------------------------------------- page
CSS = """
@font-face{font-family:'Hanken Grotesk';src:url(%(hanken)s) format('truetype');font-weight:100 900;font-display:block}
@font-face{font-family:'JetBrains Mono';src:url(%(jbm)s) format('truetype');font-weight:100 800;font-display:block}
:root{--paper:#F4F5F8;--white:#FFFFFF;--ink:#16181D;--muted:#4F5661;--faint:#636A75;--line:#E1E4E8;--strong:#7A818C;--plum:#6E2366;--plum-deep:#5A1C54;--lilac:#D9A8FA;--graphite:#1B1D21;--sel:#DFCFDD}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.55 'Hanken Grotesk',-apple-system,system-ui,sans-serif;font-feature-settings:'kern'}
a{color:var(--plum);text-underline-offset:2px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--plum);outline-offset:2px;border-radius:3px}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav.toc{position:sticky;top:0;height:100vh;overflow:auto;padding:28px 22px;background:var(--white);border-right:1px solid var(--line)}
nav.toc .brand{display:block;margin-bottom:22px}
nav.toc .brand img{height:30px;width:auto;display:block}
nav.toc .eyebrow{font:600 11px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
nav.toc ol{list-style:none;margin:0;padding:0}
nav.toc li a{display:block;padding:5px 8px;margin:0 -8px;border-radius:5px;color:var(--ink);text-decoration:none;font-size:14px;line-height:1.35}
nav.toc li a:hover{background:#EBEDF0}
main{padding:40px clamp(18px,5vw,64px) 96px;max-width:1120px;width:100%%}
header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;padding-bottom:28px;border-bottom:1px solid var(--line);margin-bottom:28px}
header.top .eyebrow{font:600 12px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--plum);margin:0 0 12px}
h1{font-weight:680;font-size:clamp(34px,5vw,52px);line-height:1.04;letter-spacing:-.02em;margin:0}
h2{font-weight:650;font-size:28px;line-height:1.15;letter-spacing:-.01em;margin:56px 0 14px;scroll-margin-top:16px}
h3{font-weight:620;font-size:19px;margin:32px 0 10px;scroll-margin-top:16px}
h4{font-weight:600;font-size:16px;margin:24px 0 8px}
p,li{max-width:76ch}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:22px}
li{margin:3px 0}
li>ul,li>ol{margin:4px 0}
strong{font-weight:650}
hr{border:0;border-top:1px solid var(--line);margin:40px 0}
code{font:500 .86em/1.4 'JetBrains Mono',ui-monospace,monospace;background:#EBEDF0;padding:.08em .32em;border-radius:4px;overflow-wrap:anywhere}
pre.code{font:13px/1.55 'JetBrains Mono',ui-monospace,monospace;background:var(--graphite);color:#DFE2E7;padding:14px 16px;border-radius:8px;overflow:auto}
pre.code code{background:none;padding:0;color:inherit}
.table-wrap{overflow-x:auto;margin:0 0 18px;border:1px solid var(--line);border-radius:8px;background:var(--white)}
table{border-collapse:collapse;width:100%%;font-size:14px;line-height:1.45}
th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--line)}
th{font-weight:620;background:#F1F2F5;color:var(--ink);position:sticky;top:0}
tr:last-child td{border-bottom:0}
td code{white-space:nowrap}
.fig{margin:18px 0 28px}
.fig figcaption{font-size:13px;color:var(--muted);margin-top:8px;max-width:90ch}
.fig img{max-width:100%%;height:auto;display:block}
.scroll{overflow-x:auto;background:var(--white);border:1px solid var(--line);border-radius:8px;padding:12px}
.scroll img{max-width:none;width:auto;max-height:none}
.scroll img.px{image-rendering:pixelated}
@media (max-width:1100px){.scroll img{max-width:100%%}}
.hero{display:flex;gap:16px;flex-wrap:wrap}
.hero>div{background:var(--white);border:1px solid var(--line);border-radius:12px;padding:18px;display:flex;flex-direction:column;align-items:center;gap:8px}
.hero img{width:clamp(120px,22vw,200px);height:auto}
.cap{font:12px 'JetBrains Mono',ui-monospace,monospace;color:var(--muted)}
.markrow{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:28px;padding:22px 24px 30px;border-radius:10px;margin-bottom:10px;border:1px solid var(--line)}
.markrow img.lockup{height:auto;width:min(100%%,400px)}
.tile-label{position:absolute;left:12px;bottom:8px;font:11px 'JetBrains Mono',ui-monospace,monospace}
.tiles{display:grid;gap:10px}
.tiles.two{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.tiles.four{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.tile{position:relative;border-radius:10px;padding:18px 16px 30px;display:flex;align-items:center;justify-content:center;gap:16px;border:1px solid var(--line);min-height:110px}
.tile img.wm{width:min(100%%,300px);height:auto}
.tile img.px{image-rendering:pixelated}
.tiles .tile .tile-label{color:var(--muted)}
.tiles .tile[style*="#1B1D21"] .tile-label,.tiles .tile[style*="#6E2366"] .tile-label{color:#DFE2E7}
.svgwrap{background:var(--white);border:1px solid var(--line);border-radius:8px;padding:12px}
.svgwrap svg{width:100%%;height:auto;max-width:680px;display:block}
.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.swatch{background:var(--white);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.chip{height:84px;display:flex;align-items:flex-end;padding:8px 10px;font-size:12px}
.sw-meta{display:flex;flex-direction:column;gap:2px;padding:10px 12px 12px;font-size:13px}
.sw-role{color:var(--muted)}
.sw-ratio{color:var(--muted);font-size:11px}
.mono{font-family:'JetBrains Mono',ui-monospace,monospace}
.type{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.t-row{background:var(--white);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.t-tag{display:block;font:600 11px 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.t-display{font-weight:680;font-size:clamp(28px,4.4vw,48px);line-height:1.08;letter-spacing:-.02em;margin:0;max-width:none}
.t-ui{font-size:13px;margin:0}
.t-mono{font:12px/1.6 'JetBrains Mono',ui-monospace,monospace;margin:0;overflow:auto;font-variant-numeric:tabular-nums}
.t-mono .k{color:var(--plum);font-weight:600}.t-mono .s{color:#0550B3}.t-mono .n{color:#734A09}.t-mono .null{color:var(--faint)}
.badge{display:inline-block;font:600 10px/16px 'Hanken Grotesk',sans-serif;letter-spacing:.04em;padding:0 4px;border-radius:3px;vertical-align:1px}
.badge.ro{border:1px solid var(--strong);color:var(--muted)}
.badge.w{background:#C62F3A;color:#fff}
.apps{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.apps img{border-radius:8px;border:1px solid var(--line);width:100%%;height:auto}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
@media (max-width:860px){.layout{grid-template-columns:minmax(0,1fr)}nav.toc{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}nav.toc ol{columns:2;column-gap:16px}.markrow{grid-template-columns:minmax(0,1fr);justify-items:start}}
@media (max-width:480px){nav.toc ol{columns:1}h2{font-size:24px}th,td{padding:7px 9px}}
"""


def main():
    import sys

    sys.path.insert(0, str(HERE))
    title, toc, body = render(SRC.read_text())
    css = CSS % {"hanken": data_uri(ID / "fonts" / "HankenGrotesk[wght].ttf"), "jbm": data_uri(ID / "fonts" / "JetBrainsMono[wght].ttf")}
    toc_html = "".join(f'<li><a href="#{sid}">{html.escape(re.sub(r"^[0-9.]+\s+", "", t))}</a></li>' for sid, t in toc)
    lockup = img("lockup/lockup-horizontal-light.svg", "Slonview")
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title>
<link rel="icon" href="{data_uri(ID / 'favicon' / 'favicon.svg')}">
<style>{css}</style></head>
<body><div class="layout">
<nav class="toc" aria-label="Contents"><a class="brand" href="#top">{lockup}</a><p class="eyebrow">Brand guidelines</p><ol>{toc_html}</ol></nav>
<main id="top">
<header class="top"><div><p class="eyebrow">Brand guidelines · Stage 3 · 2026-11-21</p><h1>{inline(title)}</h1></div></header>
{body}
<footer>Hanken Grotesk © 2021 The Hanken Grotesk Project Authors and JetBrains Mono © 2020 The JetBrains Mono Project Authors, both SIL Open Font License 1.1, embedded in this page; licence texts in <code>docs/brand/identity/fonts/</code>. Lucide icons ISC. Slonview is an independent project, not affiliated with the PostgreSQL Global Development Group. PostgreSQL is a trademark of the PostgreSQL Community Association of Canada.</footer>
</main></div></body></html>
"""
    bad = re.findall(r"(?:https?:)?//(?!www\.w3\.org/2000/svg)[a-z0-9.-]+\.[a-z]{2,}", re.sub(r"data:[^\"')]+", "", page))
    assert not bad, f"network URL in output: {bad[:5]}"
    OUT.write_text(page)
    print(f"wrote {OUT} ({len(page) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
