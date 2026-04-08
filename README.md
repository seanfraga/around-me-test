# America Around Me: Proof of Concept

Mobile web AR proof-of-concept built for a Library of Congress Innovator in Residence residency.

Displays a single hardcoded Library of Congress item at physical life-size on a SLAM-detected flat surface, viewable through a phone camera without installing an app.

---

## What this validates

- 8th Wall initialises and requests camera and motion sensor permissions correctly
- Web-to-AR pipeline works on iOS Safari and Android Chrome
- LOC document texture loads and appears at approximately correct physical scale
- Orientation (right-side-up, correct facing direction) is consistent at all compass headings

---

## Files

```
index.html    HTML shell — viewport meta, canvas, UI elements, script tags
concept.js    All AR logic — 8th Wall pipeline, texture preload, tap-to-place
CLAUDE.md     Architecture reference for AI-assisted development
README.md     This file
```

---

## Setup

**No account, App Key, or authorised-domains list required.**
The page uses `@8thwall/engine-binary`, the open-source MIT-licensed engine
served from jsDelivr. Just deploy and open on a phone.

The only hard requirement is **HTTPS** — browsers block camera access on plain
HTTP. GitHub Pages and Cloudflare Pages both serve over HTTPS automatically.

---

## How to use

1. Open the URL on a mobile device (iOS Safari or Android Chrome).
2. Grant permissions when prompted — there are three steps:
   - **8th Wall modal:** "AR requires access to device motion sensors" → tap **Continue**
   - **iOS system prompt:** "Would Like to Access Motion and Orientation" → tap **Allow**
   - **iOS system prompt:** "Would Like to Access the Camera" → tap **Allow**
3. The status bar shows **"Move camera slowly over a flat surface…"** — pan slowly over a floor, table, or other flat surface.
4. When the status bar shows **"Tap a flat surface to place item."**, tap the screen where you want the document to appear.
5. The item appears on the surface at physical life-size (176 × 118 cm).
6. After the image loads, a title card appears at the top of the screen and a **"Learn more about this item on loc.gov. ↗"** link appears at the bottom.
7. Tap anywhere on the surface to reposition the item. Reload the page to start over.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Open this page on a mobile device…" appears | Opened on a desktop browser | Open on a phone |
| "Please allow motion sensor access…" appears | Tapped Cancel on the motion sensor prompt | Reload and tap Allow on all three permission prompts |
| "Please allow camera access…" appears | Tapped Cancel on the camera prompt | Reload and tap Allow on the camera prompt |
| Stuck on "Starting up…" after granting all permissions | Engine initialisation failure | Check browser version; open DevTools (USB debugging on Android; Safari Web Inspector on iOS) and check console |
| "AR error — see console. Try reloading." | Engine runtime failure | Open DevTools and paste the error |
| "No surface detected here…" on tap | Insufficient surface texture or lighting | Point camera at a patterned surface in good light; avoid blank white floors |
| Image never loads / "Image failed to load" | LOC IIIF server unavailable or CORS issue | Open DevTools Network tab; check for 4xx/5xx or blocked request |
| Mesh appears briefly without texture | Tap happened before image preload finished | Wait a moment and reposition; the image loads automatically |

---

## Tech stack

- [@8thwall/engine-binary](https://www.npmjs.com/package/@8thwall/engine-binary) — open-source MIT framework + binary SLAM, cross-platform mobile web AR
- [Three.js r152](https://threejs.org) — 3D scene
- Static hosting — GitHub Pages or Cloudflare Pages
- [LOC IIIF Image API](https://iiif.io/api/image/3.0/) — document images at `tile.loc.gov`
