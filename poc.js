/**
 * poc.js — America Around Me, Proof of Concept
 *
 * Goals:
 *   1. Validate that 8th Wall initialises and gains camera access.
 *   2. Validate that SLAM surface detection works on the target devices.
 *   3. Validate that a LOC document texture appears at approximately
 *      correct physical scale on a detected surface.
 *
 * What is intentionally NOT in this file:
 *   • IIIF manifest fetch (texture is hardcoded)
 *   • Geolocation / proximity filtering
 *   • Navigation between items
 *   • Audio (Web Audio API)
 *   • Animations (GSAP)
 *   • 429 / retry handling (single static URL, no rate-limit risk)
 *
 * ─────────────────────────────────────────────────────────────────────
 * HARDCODED TEST ITEM
 * ─────────────────────────────────────────────────────────────────────
 *
 * Library of Congress item: "Colton's Illustrated & Embellished Steel Plate
 * Map of the World" — D. Griffing Johnson / J.H. Colton, 1854
 * Geography and Map Division, LOC item 2009579466
 * IIIF Manifest: https://www.loc.gov/item/2009579466/manifest.json
 *
 * This identifier was taken directly from the manifest's canvas @id — the
 * only reliable source for LOC IIIF identifiers. LOC identifier structure
 * varies completely by division; never guess or derive them by pattern.
 *
 * Physical dimensions from LOC MODS catalog record: 118 × 176 cm
 * (height × width, library convention). Stored in METRES for Three.js.
 * 1 Three.js unit = 1 real-world metre.
 *
 * To verify any LOC IIIF identifier, open its info.json:
 *   https://tile.loc.gov/image-services/iiif/{identifier}/info.json
 * A 200 response with JSON = valid. A 404 = wrong identifier (the server
 * also omits CORS headers on 404s, so Safari mis-reports it as a CORS error).
 *
 * Change POC_ITEM to swap in any other LOC IIIF image for testing.
 */
const POC_ITEM = {
  label: "Colton's World Map (1854)",

  // IIIF Image API URL, size-capped at 1024 on the longest dimension.
  // Identifier taken verbatim from the manifest canvas @id:
  //   service:gmd = Geography & Map Division service
  //   gmd3        = sub-collection folder
  //   g3200/g3200 = world-maps folder hierarchy
  //   ct002354    = item file ID
  imageUrl:
    'https://tile.loc.gov/image-services/iiif/service:gmd:gmd3:g3200:g3200:ct002354/full/!2048,2048/0/default.jpg',

  // Physical dimensions from LOC MODS record: "1 map : hand col. ; 118 x 176 cm"
  // Library convention is height × width, so width = 1.76 m, height = 1.18 m.
  widthM:  1.76,   // 176 cm
  heightM: 1.18,   // 118 cm
};

// ─────────────────────────────────────────────────────────────────────
// Convenience: typed reference to the status <span>
// ─────────────────────────────────────────────────────────────────────
const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ─────────────────────────────────────────────────────────────────────
// TEXTURE LOADING
// Technique: fetch → blob → createImageBitmap → THREE.Texture
//
// Why not THREE.TextureLoader?
//   TextureLoader creates an <img> element internally. On iOS Safari the
//   image is decoded on the main thread, which can stall the AR render
//   loop and cause SLAM tracking to drop frames. createImageBitmap
//   decodes off the main thread and returns a GPU-uploadable bitmap,
//   so the first render frame that actually uses the texture is smooth.
// ─────────────────────────────────────────────────────────────────────

/**
 * Loads a texture using the fetch → blob → createImageBitmap pipeline.
 *
 * @param {string} url
 * @returns {Promise<THREE.Texture>}
 */
async function loadTexture(url) {
  setStatus('Fetching image…');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  setStatus('Decoding image…');

  // createImageBitmap decodes on a worker thread (iOS 15+, all modern Android).
  const bitmap = await createImageBitmap(blob);

  const texture = new THREE.Texture(bitmap);
  texture.needsUpdate = true;          // upload to GPU on next render
  texture.colorSpace = THREE.SRGBColorSpace;  // match Three.js r152 defaults

  return texture;
}

// ─────────────────────────────────────────────────────────────────────
// PHYSICAL DIMENSIONS HELPER
// Returns the THREE.PlaneGeometry arguments for a document, in metres.
// The POC uses a single hardcoded item; in the full app this will be
// driven by a document-type lookup table keyed on IIIF manifest data.
// ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ widthM: number, heightM: number }} item
 * @returns {{ w: number, h: number }}
 */
function physicalSize(item) {
  return { w: item.widthM, h: item.heightM };
}

// ─────────────────────────────────────────────────────────────────────
// 8TH WALL CUSTOM PIPELINE MODULE
//
// 8th Wall's architecture is pipeline-based. You register one or more
// "modules" that each declare lifecycle hooks. XR8 calls these hooks
// on every frame in registration order.
//
// Surface detection strategy:
//   Rather than waiting for a specific SLAM tracking status (which varies
//   across engine versions), we use a two-path approach:
//     1. onUpdate watches for any SLAM tracking signal (LIMITED or NORMAL)
//        and unlocks tap-to-place as soon as it appears.
//     2. A 2.5-second timer fires regardless, so the user can always tap
//        even if the tracking status path never triggers.
//   On tap, XR8.XrController.hitTest() detects the surface at that exact
//   point — placement is driven by the hit test, not a global status flag.
// ─────────────────────────────────────────────────────────────────────

function buildPipelineModule() {
  // ── State ──────────────────────────────────────────────────────────
  let scene, camera, renderer;
  let documentMesh  = null;   // Three.js mesh; null until first successful hit
  let textureReady  = null;   // resolved THREE.Texture; null until loaded
  let textureApplied = false; // prevents redundant material swaps on reposition
  let readyToPlace  = false;  // true once SLAM has had time to initialise
  let readyTimer    = null;   // handle for the time-based fallback

  // ── Scene setup ────────────────────────────────────────────────────

  function initScene() {
    // XR8.Threejs.xrScene() returns the pre-built { scene, camera, renderer }
    // that 8th Wall manages. Do not create your own — use these.
    const xrScene = XR8.Threejs.xrScene();
    scene    = xrScene.scene;
    camera   = xrScene.camera;
    renderer = xrScene.renderer;

    scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    // Fetch the LOC texture in the background while the user scans for a
    // surface. Stage A/B staging will be added in the full app; for the
    // POC we just start loading immediately.
    loadTexture(POC_ITEM.imageUrl)
      .then((tex) => {
        textureReady = tex;
        // If the user already placed the mesh, apply the texture now.
        if (documentMesh && !textureApplied) {
          applyTexture(documentMesh, textureReady);
          const sizeLabel = `${(POC_ITEM.widthM * 100).toFixed(0)} × ${(POC_ITEM.heightM * 100).toFixed(0)} cm`;
          setStatus(`${POC_ITEM.label} — ${sizeLabel}`);
        }
        // Otherwise it will be applied on the next successful tap.
      })
      .catch((err) => {
        console.error('[poc] texture load error', err);
        setStatus('Image failed to load — check console.');
      });

    setStatus('Move camera slowly over a flat surface…');
  }

  // ── Mesh creation ──────────────────────────────────────────────────

  function createDocumentMesh() {
    const { w, h } = physicalSize(POC_ITEM);
    const geo = new THREE.PlaneGeometry(w, h);

    // Warm off-white placeholder while the texture is in flight.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff8e7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });

    // No rotation set here — placeOrMoveDocument sets the full rotation
    // dynamically so the bottom edge always faces the camera.
    return new THREE.Mesh(geo, mat);
  }

  function applyTexture(mesh, texture) {
    // Guard: only swap the material once. Subsequent repositions just move
    // the mesh; they don't need to rebuild the material.
    if (textureApplied) return;
    textureApplied = true;

    mesh.material.dispose();
    mesh.material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: false,
    });
  }

  // ── Placement / repositioning ───────────────────────────────────────

  /**
   * Places or repositions the document mesh at a SLAM hit-test position.
   * Creates the mesh on first call; repositions it on subsequent calls.
   *
   * @param {{ x: number, y: number, z: number }} position  World-space hit point
   */
  function placeOrMoveDocument(position) {
    if (!documentMesh) {
      // First placement — create the mesh and add it to the scene.
      documentMesh = createDocumentMesh();
      scene.add(documentMesh);
    }

    documentMesh.position.set(position.x, position.y, position.z);

    // ── Orientation ────────────────────────────────────────────────────
    // Goal: the document lies flat on the detected surface with:
    //   • image top edge facing away from the viewer (right-side-up)
    //   • image right side on the viewer's right    (no mirror)
    //
    // APPROACH: Euler 'YXZ' order — rotation.set(+π/2, θ, 0, 'YXZ')
    //
    // 'YXZ' Euler order produces matrix M = Ry(θ) · Rx(+π/2).
    //
    //   Rx(+π/2) — PlaneGeometry lies in XY; Rx(+π/2) rotates local:
    //              +Y → +Z,  +Z → −Y
    //              Normal (was +Z) → −Y (pointing down) = flat on floor. ✓
    //
    //   Ry(θ)    — spins the already-flat plane around world Y (vertical),
    //              which is axis-aligned and never causes tilt. The image top
    //              (local +Y, now world +Z after Rx) → (sinθ, 0, cosθ).
    //
    // HOW θ IS COMPUTED
    // We want the image top, (sinθ, 0, cosθ), to equal the camera-forward
    // direction projected onto XZ, (fwdX, 0, fwdZ):
    //   sinθ = fwdX,  cosθ = fwdZ  →  θ = atan2(fwdX, fwdZ).
    // Image right (local +X) → (cosθ, 0, −sinθ), which matches camera
    // right, so there is no mirror flip.
    //
    // WHY CAMERA FORWARD, NOT (camera.position - mesh.position):
    // When tapping the floor, the camera is nearly directly above the
    // hit point, so dx ≈ 0, dz ≈ 0 — atan2(0,0) is undefined and the
    // result is arbitrary. Camera forward is stable regardless of hit point.
    //
    // Three.js Matrix4 is column-major; column 2 = elements[8..10].
    // Camera looks along local −Z, so world forward = −column2.
    const fwdX = -camera.matrixWorld.elements[8];
    const fwdZ = -camera.matrixWorld.elements[10];
    // Normalise after XZ projection (fwdY is discarded).
    const fwdLen = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ) || 1;
    const nfwdX = fwdX / fwdLen;
    const nfwdZ = fwdZ / fwdLen;
    documentMesh.rotation.set(Math.PI / 2, Math.atan2(-nfwdX, -nfwdZ), 0, 'YXZ');

    if (textureReady && !textureApplied) {
      applyTexture(documentMesh, textureReady);
    }

    const sizeLabel = `${(POC_ITEM.widthM * 100).toFixed(0)} × ${(POC_ITEM.heightM * 100).toFixed(0)} cm`;
    if (textureApplied) {
      setStatus(`${POC_ITEM.label} — ${sizeLabel}`);
    } else {
      setStatus(`Placed (${sizeLabel}) — image loading…`);
    }
  }

  // ── Module API ─────────────────────────────────────────────────────

  return {
    name: 'AmericaAroundMePOC',

    onStart({ canvas }) {
      initScene();

      // Time-based fallback: if onUpdate hasn't seen any SLAM signal after
      // 2.5 s, unlock tapping anyway. The hit test itself will tell us
      // whether there is a usable surface at the tap point.
      readyTimer = setTimeout(() => {
        if (!readyToPlace) {
          readyToPlace = true;
          setStatus('Tap anywhere to place.');
        }
      }, 2500);

      // Tap-to-place / tap-to-reposition.
      // Each tap repositions the document to the new hit point.
      // touchend avoids the 300 ms click delay on iOS Safari.
      canvas.addEventListener('touchend', (e) => {
        e.preventDefault();

        if (!readyToPlace) {
          setStatus('Still initialising — try again in a moment.');
          return;
        }

        const touch = e.changedTouches[0];
        const nx = touch.clientX / window.innerWidth;
        const ny = touch.clientY / window.innerHeight;

        // Ask XrController for the world-space point on the detected surface
        // under the tap. No type filter — let the engine pick the best result.
        const hits = XR8.XrController.hitTest(nx, ny);

        if (!hits || hits.length === 0) {
          setStatus('No surface detected here — try a flat, well-lit area.');
          return;
        }

        placeOrMoveDocument(hits[0].position);
      }, { passive: false });
    },

    onUpdate({ processCpuResult }) {
      // Accelerate readiness: if SLAM reports any tracking before the 2.5 s
      // timer fires, unlock tapping immediately.
      if (readyToPlace) return;

      const slam = processCpuResult?.reality?.slam;
      if (slam?.trackingStatus === 'LIMITED' || slam?.trackingStatus === 'NORMAL') {
        readyToPlace = true;
        clearTimeout(readyTimer);
        setStatus('Tap anywhere to place.');
      }
    },

    onException(error) {
      console.error('[8th Wall] pipeline exception', error);
      setStatus('AR error — see console. Try reloading.');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// ENTRY POINT
//
// 'xrloaded' fires once both 8th Wall scripts have parsed and XR8 is
// available on window. We run the full 8th Wall startup sequence here.
// ─────────────────────────────────────────────────────────────────────

window.addEventListener('xrloaded', () => {
  // The open-source engine fires 'xrloaded' when XR8 is ready.
  // No XrExtras wrapper needed — we drive loading state ourselves.

  const canvas = document.getElementById('camerafeed');

  // ── Canvas pixel dimensions ─────────────────────────────────────────
  // The old XrExtras.FullWindowCanvas pipeline module handled this. Now
  // that we're using the open-source engine without XrExtras, we must
  // set canvas.width / canvas.height explicitly ourselves.
  //
  // Why this matters:
  //   CSS `width: 100%; height: 100%` only scales the canvas element
  //   visually. The WebGL framebuffer size is controlled by the canvas's
  //   .width and .height *attributes* (not CSS). Without setting them,
  //   they default to the HTML spec default of 300×150 px, which Safari
  //   then stretches to fill the screen — producing a blurry viewport
  //   roughly 1/5 the size of a typical phone screen.
  const resizeCanvas = () => {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resizeCanvas();                             // set before XR8.run()
  window.addEventListener('resize', resizeCanvas);  // keep in sync on rotation

  XR8.addCameraPipelineModules([
    // Core modules (order matters — keep this sequence):
    XR8.GlTextureRenderer.pipelineModule(),   // draws the camera feed
    XR8.Threejs.pipelineModule(),             // wires Three.js to XR8
    XR8.XrController.pipelineModule({
      // enableLighting: estimates ambient light from the camera feed.
      // Useful for blending documents into the scene. Enable once
      // texture placement is validated.
      enableLighting: false,

      // scale: 1 means 1 Three.js unit = 1 real-world metre.
      // Required for physical-size accuracy.
      scale: 1,
    }),

    // Our module:
    buildPipelineModule(),
  ]);

  XR8.run({ canvas });
});
