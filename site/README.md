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

- **Palette**: near-black page, layered surfaces, hairline borders, silver as the only accent —
  strictly grayscale, matching the app icon (`scripts/make-icon.mjs`, "the slashed zero").
- **Progressive motion**: hidden initial states are applied by `main.js` (never by CSS alone).
  If the GSAP CDN never answers — or `prefers-reduced-motion` is set — the page renders complete
  and static, and every interaction still works.
- **Type**: Inter for the UI, JetBrains Mono for anything that should read as code.
- **Version numbers** in the hero, download cards and FAQ are hard-coded; bump them with
  `product.json` when a new build ships (`npm run dist` writes `dist/0varflex-<version>-arm64*`).
