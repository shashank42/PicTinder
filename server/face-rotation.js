'use strict';

const sharp = require('sharp');
const path = require('path');

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif',
  '.heic', '.heif', '.avif', '.gif',
]);

let Human = null;
let human = null;
let tf = null;
let modelReady = false;
let modelLoading = null;
let disabled = false;

async function initModel() {
  if (modelReady && human) return human;
  if (disabled) return null;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    try {
      tf = require('@tensorflow/tfjs-node');
      const H = require('@vladmandic/human');
      Human = H.Human || H.default?.Human || H;

      const modelBasePath = 'file://' + path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'models') + '/';

      human = new Human({
        modelBasePath,
        backend: 'tensorflow',
        debug: false,
        async: false,
        filter: { enabled: false },
        face: {
          enabled: true,
          detector: { enabled: true, maxDetected: 10, minConfidence: 0.3, rotation: false, return: false },
          mesh: { enabled: true },
          iris: { enabled: false },
          description: { enabled: false },
          emotion: { enabled: false },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });

      await human.load();
      await human.warmup({ warmup: 'none' });

      modelReady = true;
      console.log('[face-rotation] Human model loaded');
      return human;
    } catch (err) {
      console.warn('[face-rotation] Failed to load Human model, disabling:', err.message);
      disabled = true;
      return null;
    } finally {
      modelLoading = null;
    }
  })();

  return modelLoading;
}

function isImageFile(filePath) {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Detect the needed rotation (0-3) to make people in the image upright.
 * Returns null if no faces detected or on error.
 *
 * Uses Human library's face mesh to get roll angle, then snaps to
 * nearest 90-degree rotation.
 */
async function detectFaceRotation(imagePath) {
  if (disabled || !isImageFile(imagePath)) return null;

  const h = await initModel();
  if (!h) return null;

  let tensor = null;
  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize(256, null, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    if (channels !== 3) return null;

    tensor = h.tf.tidy(() => {
      const t3d = h.tf.tensor3d(new Uint8Array(data), [height, width, 3]);
      return h.tf.expandDims(t3d, 0);
    });

    const result = await h.detect(tensor);

    if (!result.face || result.face.length === 0) return null;

    const rolls = [];
    for (const face of result.face) {
      if (face.rotation && face.rotation.angle) {
        rolls.push(face.rotation.angle.roll);
      }
    }

    if (rolls.length === 0) return null;

    // Average roll across all detected faces (in radians)
    const avgRoll = rolls.reduce((a, b) => a + b, 0) / rolls.length;
    const deg = ((avgRoll * 180) / Math.PI + 360) % 360;

    // Snap to nearest 90-degree rotation.
    // Roll ~0° means upright. We map quadrants to 90° CW rotation steps:
    //   315-45°   → correct (rotation 0)
    //   45-135°   → tilted right → rotate 270° CW (rotation 3)
    //   135-225°  → upside down → rotate 180° (rotation 2)
    //   225-315°  → tilted left → rotate 90° CW (rotation 1)
    let rotation;
    if (deg >= 315 || deg < 45) {
      rotation = 0;
    } else if (deg >= 45 && deg < 135) {
      rotation = 3;
    } else if (deg >= 135 && deg < 225) {
      rotation = 2;
    } else {
      rotation = 1;
    }

    return rotation === 0 ? null : rotation;
  } catch (err) {
    console.warn('[face-rotation] Error processing', imagePath, err.message);
    return null;
  } finally {
    if (tensor) {
      h.tf.dispose(tensor);
    }
  }
}

module.exports = { detectFaceRotation, isImageFile, initModel };
