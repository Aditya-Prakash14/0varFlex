# site/ — the 0varflex showcase

A single-page product site for 0varflex: gray & black, Inter + JetBrains Mono, GSAP for the
motion. No build step, no framework — three files.

```
site/
├── index.html   the page (semantic sections: hero, features, deep dives, architecture, CLI, download, FAQ)
├── styles.css   the design system (tokens, components, responsive, reduced-motion)
└── main.js      interactions + the GSAP layer (reveals, counters, marquee, SVG draw, typing, magnetic buttons)
```

## Run it

GSAP and the fonts load from CDNs, so it wants network; everything else is local.

```bash
# from the repository root, so ../dist/... (the download cards) resolve:
python3 -m http.server 4173
open http://localhost:4173/site/
```

Opening `site/index.html` directly works too — the download links then point at
`../dist/`, wherever the repository lives.

## Design notes

**Art direction: "obsidian blueprint".** One idea per section, construction lines everywhere.

- **Palette**: near-black surfaces, hairline borders, silver as the only accent — strictly
  grayscale, matching the app icon (`scripts/make-icon.mjs`, "the slashed zero"). One **inverted
  light band** (the numbers section) breaks the darkness on purpose.
- **Type**: Space Grotesk for display (masthead, section titles, tickers, numerals), Inter for
  copy, JetBrains Mono for anything that should read as code. The hero is a full-width masthead:
  two display lines, one metallic-shimmer word, one outlined line.
- **Signature moments**: a perspective grid floor with drifting lines in the hero; a two-row
  kinetic ticker (solid + outlined, opposite directions); the capabilities rail pinned
  horizontally with a progress hairline; sessions that stack and settle as the next one covers
  them; travelling signal pulses on the MessagePort routes of the architecture figure; a
  spotlight that follows the pointer across cards; a metallic word bleeding off the footer.
- **Progressive motion**: hidden initial states are applied by `main.js` (never by CSS alone).
  If the GSAP CDN never answers — or `prefers-reduced-motion` is set — the page renders complete
  and static, and every interaction (nav, menu, copy, FAQ) still works. The pinned rail and the
  sticky stack degrade to plain vertical flow below 900 px.
- **Version numbers** in the hero, ship section and FAQ are hard-coded; bump them with
  `product.json` when a new build ships (`npm run dist` writes `dist/0varflex-<version>-arm64*`).
