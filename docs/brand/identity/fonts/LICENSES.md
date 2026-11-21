# Font and icon licence inventory (Slonview identity, Stage 3)

| Asset | File | Licence | Copyright | Source | Used by |
|---|---|---|---|---|---|
| Hanken Grotesk (variable, wght 100–900) | `HankenGrotesk[wght].ttf` | SIL OFL 1.1, full text in `OFL-hankengrotesk.txt` | Copyright 2021 The Hanken Grotesk Project Authors | github.com/google/fonts `ofl/hankengrotesk` | Wordmark (outlined, wght 640), UI text, headlines |
| JetBrains Mono (variable, wght 100–800) | `JetBrainsMono[wght].ttf` | SIL OFL 1.1, full text in `OFL-jetbrainsmono.txt` | Copyright 2020 The JetBrains Mono Project Authors | github.com/google/fonts `ofl/jetbrainsmono` | SQL, grid data, figures, benchmark labels |
| Lucide icons | `lucide-react` 1.76.0 (app dependency) | ISC, full text in `LICENSE-lucide.txt` (includes the MIT notice for icons derived from Feather) | Copyright 2026 Lucide Icons and Contributors | the app's `node_modules/lucide-react/LICENSE` | UI icons; misread checks (`log-out`, `square-arrow-right-exit`, `battery`, `app-window`, `menu`) |

Notes:
- Every logo SVG under `docs/brand/identity/` is outlined. It contains no `<text>`, no `<image>` and no `font-family`, so no font is needed to display it.
- `wordmark/wordmark-editable.svg` references Hanken Grotesk by relative path (`../fonts/`). It is a layout draft, not a master.
- The OFL allows bundling the fonts with the app and embedding them in documents. Do not sell the font files on their own, and do not use the Reserved Font Names for modified versions.
- Retired from Stage 2: Martian Mono and Schibsted Grotesk (Concept B only). They are not part of the identity and are not shipped here.
