# Enterprise Brain branding

The product is called **Enterprise Brain** (D44 in `docs/decisions.md`).

The mark is two speech bubbles that form the two halves of a brain: blue for people, violet for agents, in one conversation. The name is set in Inter SemiBold and converted to outlines, so no font is needed to display it.

| File | Use |
| --- | --- |
| `logo.svg`, `png/logo.png` | Mark and name, on light backgrounds |
| `logo-white.svg`, `png/logo-white.png` | Mark and name, on dark backgrounds |
| `mark.svg`, `png/mark-512.png` | The mark alone: avatars, the login page, splash screens |
| `mark-small.svg`, `png/favicon-32.png` | The mark without folds, for 32 px and smaller |
| `app-icon.svg`, `png/app-icon-1024.png` | App icon on white (iOS, Android, desktop). The stores apply their own corner shape. |
| `app-icon-dark.svg`, `png/app-icon-dark-1024.png` | App icon on dark |

Colours: blue `#2563EB`, violet `#7C3AED`, ink `#0F172A` (the name on light backgrounds), white.

- Keep both colours in their places (blue left, violet right). Do not stretch, rotate or outline the mark.
- Leave clear space around the logo of at least a quarter of the mark's height.
- The folds are cut out of the halves, so the background shows through them.
- The SVG files are the source. The PNG files are exports of them at the sizes in their names, rendered with headless Chrome; export again after changing an SVG.

Typeface: Inter by Rasmus Andersson, under the SIL Open Font License 1.1. The source was the variable font `ofl/inter/Inter[opsz,wght].ttf` from the google/fonts repository (SHA-256 `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`), set at weight 600 and optical size 32 and shaped with HarfBuzz (kerning on). The outlines are artwork, not a font, so no font file ships with them.

Where it is used:

- `pnpm dev:seed` sets Mattermost's site name, the login-page image (`png/mark-512.png`) and its description (D44).
- Our own Mattermost build ([tintin222/enterprise-brain-chat](https://github.com/tintin222/enterprise-brain-chat), D48) carries the logo in its web app: login page and header (without an edition badge), browser and app icons, email logos and the About dialog. Its icon files were rendered from these SVG files at the sizes Mattermost uses, with the favicon's mention and unread dots added.
