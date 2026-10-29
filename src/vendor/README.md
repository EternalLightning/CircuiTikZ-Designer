# Local startup assets

These files are served with the editor, so startup does not depend on a public CDN.

| Assets | Source | License |
| --- | --- | --- |
| `mathjax/tex-svg.js`, `mathjax/textmacros.js` | MathJax 3.2.2, `mathjax-full/es5` | Apache 2.0, `mathjax/LICENSE` |
| `fonts/CMUSerif-*.woff2`, `fonts/serif.css` | https://github.com/vsalvino/computer-modern/tree/main/fonts | SIL OFL 1.1, `fonts/LICENSE-computer-modern.txt` |
| `fonts/cmunrm.woff` | https://github.com/dreampulse/computer-modern-web-font/tree/master/font/Serif | SIL OFL 1.1, `fonts/LICENSE-cmunrm.txt` |
| `fonts/material-symbols-outlined.ttf`, `fonts/material-symbols.css` | Google Fonts Material Symbols Outlined, static 24px / 400 / FILL 0 / GRAD 0 | Apache 2.0, `fonts/LICENSE-material-symbols.txt` |

Font binaries and MathJax are unchanged upstream files. The Material Symbols CSS uses a relative local font URL and explicit font-display. The font source was the Google Fonts CSS2 endpoint, version v382, downloaded on 2026-10-29.

The HTML preloads the formula engine, its textmacros extension, and the font used for text outlines. Keep these links in sync with the controller loaders when upgrading assets. Parcel rewrites them to content-hashed production URLs, including the MathJax extension's loader source mapping.
