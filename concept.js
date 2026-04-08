/**
 * concept.js — America Around Me, Proof of Concept
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
 * Change CONCEPT_ITEM to swap in any other LOC IIIF image for testing.
 */
const CONCEPT_ITEM = {
  label: "Colton's World Map (1854)",

  // IIIF Image API URL, size-capped at 4096 on the longest dimension.
  // Identifier taken verbatim from the manifest canvas @id:
  //   service:gmd = Geography & Map Division service
  //   gmd3        = sub-collection folder
  //   g3200/g3200 = world-maps folder hierarchy
  //   ct002354    = item file ID
  imageUrl:
    'https://tile.loc.gov/image-services/iiif/service:gmd:gmd3:g3200:g3200:ct002354/full/!4096,4096/0/default.jpg',

  // Physical dimensions from LOC MODS record: "1 map : hand col. ; 118 x 176 cm"
  // Library convention is height × width, so width = 1.76 m, height = 1.18 m.
  widthM:  1.76,   // 176 cm
  heightM: 1.18,   // 118 cm
};

// ─────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────
const statusEl    = /** @type {HTMLElement} */ (document.getElementById('status'));
const overlayEl   = /** @type {HTMLElement} */ (document.getElementById('overlay'));
const itemInfoEl  = /** @type {HTMLElement} */ (document.getElementById('item-info'));
const itemTitleEl = /** @type {HTMLElement} */ (document.getElementById('item-title'));

/** Shows the status pill with a plain-text message; hides item cards. */
function setStatus(msg) {
  itemTitleEl.style.display = 'none';
  itemInfoEl.style.display  = 'none';
  overlayEl.style.display   = 'flex';
  statusEl.textContent = msg;
}

/** Shows the title card (top) and learn-more link (bottom); hides status pill. */
function showItemLink() {
  overlayEl.style.display   = 'none';
  itemTitleEl.style.display = 'flex';
  itemInfoEl.style.display  = 'flex';
}

/**
 * Hides AR chrome and shows a full-screen fallback message.
 * @param {'motion'|'camera'} type
 */
function showFallback(type) {
  overlayEl.style.display   = 'none';
  itemTitleEl.style.display = 'none';
  itemInfoEl.style.display  = 'none';
  document.getElementById('camerafeed').style.display = 'none';
  const id = type === 'camera' ? 'fallback-camera' : 'fallback-motion';
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

// ─────────────────────────────────────────────────────────────────────
// MODULE-LEVEL DOCUMENT STATE
//
// textureReady, textureApplied, and documentMesh are lifted to module
// scope so the texture preload (below) can set textureReady and
// immediately apply it to an already-placed mesh, without waiting for
// the next user tap.
// ─────────────────────────────────────────────────────────────────────
let textureReady      = null;   // resolved THREE.Texture; null until loaded
let textureApplied    = false;  // true after first material swap on the mesh
let textureLoadFailed = false;  // true if the preload fetch or decode failed
let documentMesh      = null;   // Three.js mesh; null until first tap

/**
 * Swaps the placeholder material for the real texture.
 * Guard prevents redundant swaps if called more than once.
 */
function applyTexture(mesh, texture) {
  if (textureApplied) return;
  textureApplied = true;
  mesh.material.dispose();
  mesh.material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    transparent: false,
  });
}

// ─────────────────────────────────────────────────────────────────────
// TEXTURE PRELOAD
//
// Fetches the LOC image as soon as this script executes — before 8th
// Wall initialises, before the user scans a surface, before the first
// tap. The typical time from script load to first tap is 5–10 seconds,
// which is enough to fetch, decode, and upload the texture. The user
// should never see the blank off-white placeholder.
//
// Technique: fetch → blob → createImageBitmap → THREE.Texture
// Why not THREE.TextureLoader?
//   TextureLoader creates an <img> internally. On iOS Safari, image
//   decoding is synchronous on the main thread and can stall the AR
//   render loop. createImageBitmap decodes on a worker thread (iOS 15+,
//   all modern Android), keeping the frame rate smooth.
//
// Silent: no status messages during preload — the user sees normal
// AR prompts ("Move camera…", "Tap to place") while the image loads
// in the background.
// ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const response = await fetch(CONCEPT_ITEM.imageUrl);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const tex = new THREE.Texture(bitmap);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    textureReady = tex;
    // Edge case: user placed the mesh before the fetch finished.
    // Apply the texture immediately rather than waiting for the next tap.
    if (documentMesh && !textureApplied) {
      applyTexture(documentMesh, tex);
      showItemLink();
    }
  } catch (err) {
    console.error('[concept] texture preload failed', err);
    textureLoadFailed = true;
    if (documentMesh) {
      setStatus('Image failed to load — check console.');
    }
  }
})();

// ─────────────────────────────────────────────────────────────────────
// PHYSICAL DIMENSIONS HELPER
// Returns the THREE.PlaneGeometry arguments for a document, in metres.
// This proof of concept uses a single hardcoded item; in the full app
// this will be driven by a document-type lookup table keyed on IIIF
// manifest data.
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
  let readyToPlace  = false;  // true once SLAM has had time to initialise
  let readyTimer    = null;   // handle for the time-based fallback
  let arSessionLive = false;  // true once onStart fires successfully

  // ── Scene setup ────────────────────────────────────────────────────

  function initScene() {
    // XR8.Threejs.xrScene() returns the pre-built { scene, camera, renderer }
    // that 8th Wall manages. Do not create your own — use these.
    const xrScene = XR8.Threejs.xrScene();
    scene    = xrScene.scene;
    camera   = xrScene.camera;
    renderer = xrScene.renderer;

    // No lights added — MeshBasicMaterial ignores lighting entirely,
    // so AmbientLight / DirectionalLight would be dead scene-graph nodes.

    setStatus('Move camera slowly over a flat surface…');
  }

  // ── Mesh creation ──────────────────────────────────────────────────

  function createDocumentMesh() {
    const { w, h } = physicalSize(CONCEPT_ITEM);
    const geo = new THREE.PlaneGeometry(w, h);

    // Warm off-white placeholder while the texture is in flight.
    // With preloading, this should rarely be visible.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff8e7,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7,
    });

    return new THREE.Mesh(geo, mat);
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
    //   • image bottom edge nearest the viewer (right-side-up)
    //   • image right side on the viewer's right (no mirror)
    //
    // APPROACH: Euler 'YXZ' order — rotation.set(+π/2, θ, 0, 'YXZ')
    //
    // 'YXZ' Euler order produces matrix M = Ry(θ) · Rx(+π/2).
    //
    //   Rx(+π/2) — PlaneGeometry lies in XY. After Rx(+π/2):
    //              local +Y → world +Z, normal → world −Y (pointing down).
    //              The plane is flat on the floor regardless of θ. ✓
    //
    //   Ry(θ)    — spins the flat plane around world Y.
    //              Local +Y (image bottom, due to Three.js flipY=true)
    //              maps to world direction (sinθ, 0, cosθ).
    //
    // HOW θ IS COMPUTED
    // We want image bottom facing toward the viewer, i.e. in the direction
    // OPPOSITE to camera forward:
    //   sinθ = −fwdX, cosθ = −fwdZ  →  θ = atan2(−fwdX, −fwdZ)
    //
    // WHY CAMERA FORWARD, NOT (camera.position − mesh.position):
    // When tapping the floor, dx ≈ 0 and dz ≈ 0 — atan2(0,0) is
    // undefined. Camera forward is stable regardless of tap location.
    //
    // Three.js Matrix4 is column-major; column 2 = elements[8..10].
    // Camera looks along local −Z, so world forward = −column2.
    const fwdX = -camera.matrixWorld.elements[8];
    const fwdZ = -camera.matrixWorld.elements[10];
    // Normalise after XZ projection (fwdY discarded).
    const fwdLen = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ) || 1;
    const nfwdX = fwdX / fwdLen;
    const nfwdZ = fwdZ / fwdLen;
    documentMesh.rotation.set(Math.PI / 2, Math.atan2(-nfwdX, -nfwdZ), 0, 'YXZ');

    // ── Texture / status ───────────────────────────────────────────────
    if (!textureApplied) {
      if (textureReady) {
        // Preload finished before first tap — apply immediately, no flash.
        applyTexture(documentMesh, textureReady);
        showItemLink();
      } else if (textureLoadFailed) {
        setStatus('Image failed to load — check console.');
      } else {
        // Still loading — show message; preload IIFE will apply when done.
        const sizeLabel = `${(CONCEPT_ITEM.widthM * 100).toFixed(0)} × ${(CONCEPT_ITEM.heightM * 100).toFixed(0)} cm`;
        setStatus(`Placed (${sizeLabel}) — image loading…`);
      }
    } else {
      // Repositioning after texture already applied.
      showItemLink();
    }
  }

  // ── Module API ─────────────────────────────────────────────────────

  return {
    name: 'AmericaAroundMeConcept',

    onStart({ canvas }) {
      arSessionLive = true;
      initScene();

      // Time-based fallback: if onUpdate hasn't seen any SLAM signal after
      // 2.5 s, unlock tapping anyway. The hit test itself will tell us
      // whether there is a usable surface at the tap point.
      readyTimer = setTimeout(() => {
        if (!readyToPlace) {
          readyToPlace = true;
          setStatus('Tap a flat surface to place item.');
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
        setStatus('Tap a flat surface to place item.');
      }
    },

    onException(error) {
      console.error('[concept] pipeline exception', error);
      if (!arSessionLive) {
        // Exception before the AR session started — almost certainly a
        // permission denial (motion sensors or camera). Show the
        // appropriate fallback based on what the error message mentions.
        const msg = String(error?.message || error || '');
        if (/camera|video|capture/i.test(msg)) {
          showFallback('camera');
        } else {
          // Motion sensor denial, or any other pre-session error.
          showFallback('motion');
        }
      } else {
        setStatus('AR error — see console. Try reloading.');
      }
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

  // ── Camera permission intercept ─────────────────────────────────────
  // When the user taps Cancel on the iOS "Would Like to Access the Camera"
  // prompt, the browser rejects getUserMedia with NotAllowedError.
  // 8th Wall may silently swallow this error (leaving the page frozen at
  // "Initialising AR…"), so we intercept it here and show the fallback.
  if (navigator.mediaDevices?.getUserMedia) {
    const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (...args) {
      try {
        return await origGUM(...args);
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showFallback('camera');
        }
        throw err;
      }
    };
  }

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
