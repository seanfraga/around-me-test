# CLAUDE.md — America Around Me

Project context and architecture reference for AI-assisted development.
Update this file whenever a locked decision changes or a new phase begins.

---

## Project overview

**America Around Me** is a mobile web AR application built for a Library of
Congress Innovator in Residence residency. It surfaces LOC collection items
at physical life-size on SLAM-detected real-world surfaces, viewable through
a phone camera without installing an app.

**Repo:** https://github.com/seanfraga/around-me-test
**Hosting:** GitHub Pages (static, no server-side logic)

---

## Tech stack (locked — do not substitute)

| Layer | Choice | Rationale |
|---|---|---|
| AR runtime | `@8thwall/engine-binary` (open-source MIT + binary SLAM) | Only cross-platform mobile web AR that works on iOS Safari + Android Chrome without WebXR Device API |
| 3D scene | Three.js r152 | Required by 8th Wall's `XR8.Threejs.pipelineModule()`; pinned to r152 for compatibility |
| Hosting | GitHub Pages / Cloudflare Pages | Static; no backend needed for POC or full app |
| Images | LOC IIIF Image API + Presentation API | Official LOC collection access; standard IIIF 2.1 |
| Audio | Web Audio API | No dependency, works everywhere |
| Animation | GSAP | Easing and timeline control for AR transitions |

---

## Architecture decisions (locked — do not override)

### Texture loading pipeline
```
fetch(url) → response.blob() → createImageBitmap(blob) → new THREE.Texture(bitmap)
```
**Never use `THREE.TextureLoader`.** It creates an `<img>` element internally,
which decodes on the main thread on iOS Safari and stalls the AR render loop.
`createImageBitmap` decodes off the main thread and returns a GPU-uploadable
bitmap; the first rendered frame is smooth.

### Physical dimensions
Document physical size comes from a **hardcoded lookup table** keyed on
document type (e.g. `photo_8x10`, `letter`, `broadside_full`).

**Never use IIIF `physicalUnits` / `physicalScale`.** LOC does not provide
these fields in their manifests. The lookup table is the sole source of truth
for physical sizing.

Document sizes in metres (1 Three.js unit = 1 real-world metre):

| Key | Size | Inches |
|---|---|---|
| `photo_4x5` | 0.1016 × 0.1270 m | 4×5 in |
| `photo_8x10` | 0.2032 × 0.2540 m | 8×10 in |
| `letter` | 0.2159 × 0.2794 m | 8.5×11 in |
| `legal` | 0.2159 × 0.3556 m | 8.5×14 in |
| `broadside_half` | 0.2794 × 0.4318 m | 11×17 in |
| `broadside_full` | 0.4318 × 0.5588 m | 17×22 in |
| `map_small` | 0.6096 × 0.4572 m | 24×18 in |
| `map_medium` | 0.9144 × 0.6096 m | 36×24 in |

### Staged loading
- **Stage A** — fetch IIIF Presentation manifest only (metadata: label, dimensions hint, image service URL). Do not fetch the image.
- **Stage B** — fetch the image texture after the user places the surface anchor. Cancel any in-flight Stage B fetch if the user navigates away before it completes.

### IIIF image size cap
Default request size: `!1024,1024` (longest dimension ≤ 1024 px).
Increase only if scale validation shows the texture is visibly low-resolution
at the target physical size.

### 429 / rate-limit handling
Exponential backoff with a user-visible retry message in the status bar.
Do not silently retry in the background.

### Request cancellation
Use `AbortController` to cancel in-flight texture fetches when the user
navigates away from a placed item.

### Canvas pixel dimensions
`XrExtras.FullWindowCanvas` is not available in the open-source engine.
We must set `canvas.width = window.innerWidth; canvas.height = window.innerHeight`
explicitly before `XR8.run()` and re-apply on `window resize`. Failing to
do this causes WebGL to render at the HTML default of 300×150 px, which
Safari then stretches across the full screen (~1/5 effective resolution).

### LOC IIIF URL validation
A valid LOC IIIF identifier returns JSON from its `info.json` endpoint:
```
https://tile.loc.gov/image-services/iiif/{identifier}/info.json
```
An invalid identifier returns a 404. LOC's server does not send
`Access-Control-Allow-Origin` on 404 responses, so Safari reports the
failure as a CORS error — masking the real cause (wrong identifier).
Always verify a new identifier via `info.json` before hardcoding it.

**Identifier structure varies completely by LOC division.** Never guess or
derive identifiers by pattern — always take them verbatim from the manifest
canvas `@id` field. Examples from confirmed-working items:

| Division | Example identifier |
|---|---|
| Geography & Map (gmd) | `service:gmd:gmd3:g3200:g3200:ct002354` |
| Prints & Photographs (pnp) | TBD — requires manifest verification |

**LOC physical dimensions** are not in the IIIF manifest. Retrieve them from
the MODS record linked in the manifest's `seeAlso` array:
```
https://lccn.loc.gov/{lccn}/mods
```
Look for the `<physicalDescription><extent>` field.
Note: the main `loc.gov` item pages return 403 from Cloudflare bot protection
when fetched programmatically; the MODS endpoint does not.

---

## Build phases

### Phase 1 — POC (current)
**Goal:** validate the AR stack end-to-end with zero dynamic data.
- Hardcoded LOC item (no IIIF manifest fetch)
- No geolocation, no navigation, no audio, no animation
- One document placed on a SLAM-detected surface at physical scale
- Files: `index.html`, `poc.js`

**Test item:** "Colton's World Map" — D. Griffing Johnson / J.H. Colton, 1854
- LOC item: 2009579466
- IIIF manifest: `https://www.loc.gov/item/2009579466/manifest.json`
- IIIF identifier (from manifest canvas @id): `service:gmd:gmd3:g3200:g3200:ct002354`
- Physical size (from MODS record): 176 × 118 cm → 1.76 m × 1.18 m

### Phase 2 — Full app (TBD)
Begins after Phase 1 validates on iOS Safari + Android Chrome.
Will add: IIIF manifest fetch, geolocation, multi-item navigation,
Web Audio API sound effects, GSAP transitions.

---

## Key implementation notes

- Three.js must be loaded **synchronously** in `<head>` so `THREE` is a
  global before 8th Wall's `XR8.Threejs.pipelineModule()` initialises.
- The 8th Wall engine script is `async`; all our code runs inside the
  `xrloaded` event callback, which fires once the engine is ready.
- `XR8.XrController.pipelineModule({ scale: 1 })` — the `scale: 1`
  option is required so that 1 Three.js unit equals 1 real-world metre.
  Omitting it produces arbitrary scale and makes physical sizing wrong.
- `touchend` (not `click`) is used for tap-to-place on iOS Safari to
  avoid the 300 ms click delay.
- `{ passive: false }` on the touchend listener is required so that
  `e.preventDefault()` can suppress scroll/zoom during AR interaction.

---

## Working with this project

Sean is the project owner. He is technically proficient but does not write
code. Claude writes all code. Sean handles terminal commands, file placement,
device testing, and feeding back console output for debugging.

When Claude makes changes:
1. Always create a new git branch.
2. Commit with a descriptive message.
3. Provide the GitHub PR URL or instructions to open one.
