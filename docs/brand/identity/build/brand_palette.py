"""Final Slonview palette (Stage 3, Concept A). Single source for marks, icons, tokens and checks."""

BRAND = {
    "plum": "#6E2366",  # accent on light
    "plum_deep": "#5A1C54",  # accent hover on light, icon tile bottom
    "plum_tile": "#7A2A71",  # icon tile top
    "lilac": "#D9A8FA",  # accent on dark (MAJOR-1: was #E2A6D9)
    "lilac_deep": "#C18DEC",  # accent hover on dark (protan ΔE ≥ 45 from error and WRITE)
    "ink": "#16181D",
    "paper": "#F4F5F8",
    "graphite": "#30333A",  # dark icon tile top
    "graphite_deep": "#1B1D21",
    "fog": "#DFE2E7",  # frame on dark
    "quiet_light": "#868D98",  # quiet rows on light grounds (MINOR-2)
    "quiet_dark": "#767D88",  # quiet rows on dark grounds (MINOR-2)
    "quiet_on_plum": "#B8BEC8",  # quiet rows on the plum icon tile
    "quiet_on_graphite": "#868D98",  # quiet rows on the graphite icon tile
}

FUNCTIONAL = {
    "write_light": "#C62F3A",
    "write_light_fg": "#FFFFFF",
    "write_dark": "#FF7B80",
    "write_dark_fg": "#16181D",
    "error_light": "#C62F3A",
    "error_dark": "#FF8F94",
}

SYMBOL_COLOURS = {
    "light": {"frame": BRAND["ink"], "quiet": BRAND["quiet_light"], "row": BRAND["plum"]},
    "dark": {"frame": BRAND["fog"], "quiet": BRAND["quiet_dark"], "row": BRAND["lilac"]},
    "mono": {"frame": BRAND["ink"], "quiet": BRAND["ink"], "row": BRAND["ink"]},
    "reversed": {"frame": "#FFFFFF", "quiet": "#FFFFFF", "row": "#FFFFFF"},
}

WORDMARK_COLOURS = {
    "light": {"ink": BRAND["ink"], "accent": BRAND["plum"]},
    "dark": {"ink": BRAND["paper"], "accent": BRAND["lilac"]},
    "mono": {"ink": BRAND["ink"], "accent": BRAND["ink"]},
    "reversed": {"ink": "#FFFFFF", "accent": "#FFFFFF"},
}

# Ground each colourway is drawn for (used for previews and contrast checks).
GROUNDS = {"light": BRAND["paper"], "dark": BRAND["graphite_deep"], "mono": "#FFFFFF", "reversed": BRAND["plum"]}

ICON = {
    "light": {"tile": BRAND["plum_tile"], "tile2": BRAND["plum_deep"], "frame": BRAND["paper"], "quiet": BRAND["quiet_on_plum"], "row": BRAND["lilac"], "rim": None},
    "dark": {"tile": BRAND["graphite"], "tile2": BRAND["graphite_deep"], "frame": BRAND["fog"], "quiet": BRAND["quiet_on_graphite"], "row": BRAND["lilac"], "rim": "#FFFFFF"},
}
