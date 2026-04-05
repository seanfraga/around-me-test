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
 * Library of Congress item: "Migrant Mother" — Dorothea Lange, 1936
 * FSA/OWI Collection, LC-DIG-fsa-8b29516
 * IIIF Image URL: a 1024×1024-capped JPEG served by the LOC IIIF endpoint.
 *
 * Physical size: standard 8×10 inch photographic print = 0.2032 m × 0.2540 m.
 * We store dimensions in METRES for Three.js (1 unit = 1 metre).
 *
 * To verify any LOC IIIF identifier before using it, open its info.json:
 *   https://tile.loc.gov/image-services/iiif/{identifier}/info.json
 * A valid identifier returns JSON; an invalid one returns a 404 (which
 * also suppresses the CORS header, making it look like a CORS error).
 *
 * Change POC_ITEM to swap in any other LOC IIIF image for testing.
 */
const POC_ITEM = {
  label: 'Migrant Mother (Dorothea Lange, 1936)',

  // IIIF Image API URL, size-capped at 1024 on the longest dimension.
  // Identifier breakdown: service:pnp = Prints & Photographs service;
  //   fsa = FSA/OWI sub-collection; 8b29000 = folder (files 8b29000–8b29999);
  //   8b29516u = file ID ('u' suffix = unretouched b&w master).
  imageUrl:
    'https://tile.loc.gov/image-services/iiif/service:pnp:fsa:8b29000:8b29516u/full/!1024,1024/0/default.jpg',

  // Physical dimensions of the original print in METRES.
  // Source: document-type lookup table (not IIIF physicalUnits).
  // Standard FSA 8×10 photographic print: 8 in × 10 in
  widthM:  0.2032,   // 8 inches
  heightM: 0.2540,   // 10 inches
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
// The hooks we use:
//   name()           — identifies this module in 8th Wall's debug output
//   onStart()        — called once after XR8 initialises; we build the
//                      Three.js scene here and start loading the texture
//   onUpdate()       — called every frame with camera pose + surface data;
//                      we use it to handle tap-to-place
//   onException()    — called if 8th Wall throws internally; we surface
//                      the error to the user
// ─────────────────────────────────────────────────────────────────────

function buildPipelineModule() {
  // ── State ──────────────────────────────────────────────────────────
  let scene, camera, renderer;
  let documentMesh = null;     // the placed Three.js mesh (null until placed)
  let textureReady = null;     // resolved THREE.Texture (null until loaded)
  let surfaceFound = false;    // true once SLAM has detected a horizontal plane
  let placed = false;          // true once the user has tapped to place

  // ── Scene setup ────────────────────────────────────────────────────

  function initScene(canvas) {
    // 8th Wall provides XR8.Threejs.xrScene() which contains a pre-built
    // { scene, camera, renderer } wired to the camera feed canvas.
    const xrScene = XR8.Threejs.xrScene();
    scene    = xrScene.scene;
    camera   = xrScene.camera;
    renderer = xrScene.renderer;

    // Ambient light so the texture is visible without directional shadows.
    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambient);

    // Directional light at ~45° above, casting gentle shadows.
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(1, 2, 1);
    scene.add(sun);

    // Start fetching the texture in parallel with the user finding a surface.
    loadTexture(POC_ITEM.imageUrl)
      .then((tex) => {
        textureReady = tex;

        // If the user already placed the mesh before the texture arrived,
        // apply it now. (Unlikely in practice but handles slow connections.)
        if (documentMesh) {
          applyTexture(documentMesh, textureReady);
          setStatus('Placed! Move around to inspect.');
        } else if (placed) {
          // placed flag set but mesh not yet created — shouldn't happen, but safe.
        } else if (surfaceFound) {
          setStatus('Surface found — tap to place.');
        } else {
          setStatus('Move your camera slowly over a flat surface.');
        }
      })
      .catch((err) => {
        console.error('[poc] texture load error', err);
        setStatus('Image failed to load. Check console for details.');
      });

    setStatus('Move your camera slowly over a flat surface.');
  }

  // ── Mesh creation ──────────────────────────────────────────────────

  function createDocumentMesh() {
    const { w, h } = physicalSize(POC_ITEM);
    const geometry = new THREE.PlaneGeometry(w, h);

    // While the texture loads we show a semi-transparent placeholder so the
    // user has visual confirmation that placement worked.
    const material = new THREE.MeshBasicMaterial({
      color: 0xfff8e7,          // warm off-white, like aged parchment
      side: THREE.DoubleSide,   // visible from both sides (user may tilt phone)
      transparent: true,
      opacity: 0.7,
    });

    const mesh = new THREE.Mesh(geometry, material);

    // By default PlaneGeometry is vertical (facing +Z).
    // We rotate it −90° around X so it lies flat on the detected surface,
    // parallel to the ground plane.
    mesh.rotation.x = -Math.PI / 2;

    return mesh;
  }

  function applyTexture(mesh, texture) {
    // Replace the placeholder material with the real textured one.
    mesh.material.dispose();
    mesh.material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: false,
    });
  }

  // ── Placement ──────────────────────────────────────────────────────

  /**
   * Places the document mesh at the given world-space position.
   * Called on tap when a surface has been detected.
   *
   * @param {{ x: number, y: number, z: number }} position  World-space hit point
   * @param {{ x: number, y: number, z: number, w: number }} rotation  Hit-point quaternion
   */
  function placeDocument(position, rotation) {
    if (placed) return;  // only allow one placement in the POC
    placed = true;

    documentMesh = createDocumentMesh();

    // Position at the SLAM hit point.
    documentMesh.position.set(position.x, position.y, position.z);

    // We ignore the hit-point rotation for this POC — keeping the document
    // axis-aligned simplifies scale validation. The full app will align to
    // the surface normal.

    scene.add(documentMesh);

    if (textureReady) {
      applyTexture(documentMesh, textureReady);
      setStatus('Placed! Move around to inspect.');
    } else {
      setStatus('Placed! Loading image…');
    }
  }

  // ── Module API ─────────────────────────────────────────────────────

  return {
    name: 'AmericaAroundMePOC',

    onStart({ canvas }) {
      initScene(canvas);

      // Tap-to-place: listen for touchend on the canvas.
      // We use touchend (not click) because 'click' has a ~300ms delay
      // on iOS Safari unless the page declares touch-action: manipulation.
      canvas.addEventListener('touchend', (e) => {
        e.preventDefault();

        if (!surfaceFound) {
          setStatus('Keep moving the camera over a flat surface…');
          return;
        }
        if (placed) return;  // already placed

        // Ask 8th Wall for a surface hit at the centre of the screen.
        // XrController.recenterCamera() or hitTest can be used here.
        // The simplest approach for the POC: place at the last known
        // surface position, which 8th Wall stores in XrController.
        const hitTestResults = XR8.XrController.hitTest(
          // normalised screen coords: centre of the screen
          e.changedTouches[0].clientX / window.innerWidth,
          e.changedTouches[0].clientY / window.innerHeight,
          // hit-test types: mesh surface only (no feature points in POC)
          ['FEATURE_POINT', 'ESTIMATED_SURFACE']
        );

        if (hitTestResults.length === 0) {
          setStatus('Couldn\'t detect a surface here. Try tapping elsewhere.');
          return;
        }

        const hit = hitTestResults[0];
        placeDocument(hit.position, hit.rotation);
      }, { passive: false });
    },

    onUpdate({ processCpuResult }) {
      // processCpuResult contains the SLAM output for this frame.
      // We use it only to update the surfaceFound flag and status text.
      if (!processCpuResult?.reality) return;

      const { detectedImages, slam } = processCpuResult.reality;

      // Check if SLAM has a confident surface estimate this frame.
      // XrController provides surface tracking confidence via the
      // `trackingStatus` field. 'LIMITED' = some tracking, 'NORMAL' = confident.
      if (!placed && slam && slam.trackingStatus === 'NORMAL') {
        if (!surfaceFound) {
          surfaceFound = true;
          setStatus('Surface found — tap to place.');
        }
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
