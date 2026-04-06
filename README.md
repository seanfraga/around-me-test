# America Around Me — Proof of Concept

Mobile web AR proof-of-concept.

Displays a single hardcoded Library of Congress item at physical life-size on a flat surface.


---

## What this validates

- 8th Wall initialises and requests camera permission correctly
- Web-to-AR pipeline works on iOS Safari and Android Chrome
- Texture appears at approximately correct physical scale

---

## Files

```
index.html   HTML shell — viewport meta, canvas, overlay UI, script tags
poc.js       All AR logic — 8th Wall pipeline, texture loader, tap-to-place
README.md    This file
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
2. Allow camera access when prompted.
3. Slowly pan your camera over a flat horizontal surface (floor, table, desk).
4. When the status bar says **"Surface found — tap to place"**, tap the screen.
5. The item appears on the surface.
6. Move around it to verify scale and orientation.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank screen / no camera | Page not served over HTTPS | Deploy to GitHub Pages / Cloudflare Pages |
| "AR error — see console" | Engine internal failure | Open browser DevTools (USB debugging on Android; Safari Web Inspector on iOS) and paste the error |
| Image never loads | LOC IIIF server unavailable or CORS issue | Open DevTools Network tab; check for 4xx/5xx or blocked request |
| Surface never found | Insufficient texture / lighting | Point camera at a patterned surface in good light; avoid blank white floors |
| Mesh appears but no texture | `createImageBitmap` not supported | Check browser version; iOS 15+ and Android Chrome 90+ required |

---

## Tech stack

- [@8thwall/engine-binary](https://www.npmjs.com/package/@8thwall/engine-binary) — open-source MIT framework + binary SLAM, cross-platform mobile web AR
- [Three.js r152](https://threejs.org) — 3D scene
- Static hosting — GitHub Pages or Cloudflare Pages
- [LOC IIIF Image API](https://iiif.io/api/image/3.0/) — document images
