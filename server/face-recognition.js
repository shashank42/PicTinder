'use strict';

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const IMAGE_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif',
    '.heic', '.heif', '.avif', '.gif',
]);

// ---- Lazy-loaded modules ----

let Human = null;
let human = null;
let tf = null;
let modelsLoaded = false;
let modelLoadPromise = null;
let disabled = false;
let usingGpu = false;

// ---- Constants ----

const DEFAULT_DISTANCE_THRESHOLD = 0.45;
const DEFAULT_MIN_CONFIDENCE = 0.2;
const DEFAULT_INPUT_SIZE = 2048;

const settings = {
    distanceThreshold: DEFAULT_DISTANCE_THRESHOLD,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    inputSize: DEFAULT_INPUT_SIZE,
};

function getSettings() {
    return { ...settings };
}

function updateSettings(newSettings) {
    if (newSettings.distanceThreshold !== undefined) {
        settings.distanceThreshold = Math.max(0.1, Math.min(0.9, Number(newSettings.distanceThreshold)));
    }
    if (newSettings.minConfidence !== undefined) {
        settings.minConfidence = Math.max(0.1, Math.min(0.95, Number(newSettings.minConfidence)));
    }
    if (newSettings.inputSize !== undefined) {
        settings.inputSize = Math.max(256, Math.min(2048, Number(newSettings.inputSize)));
    }
    console.log(`[face-recognition] Settings updated:`, settings);
}

// ---- Initialization ----

/**
 * Load Human library models (detection, mesh, description/embedding).
 * Safe to call multiple times; will only load once.
 */
async function initModels() {
    if (modelsLoaded) return true;
    if (disabled) return false;
    if (modelLoadPromise) return modelLoadPromise;

    modelLoadPromise = (async () => {
        try {
            try {
                tf = require('@tensorflow/tfjs-node-gpu');
                usingGpu = true;
                console.log('[face-recognition] Loaded GPU-accelerated TensorFlow (CUDA)');
            } catch {
                tf = require('@tensorflow/tfjs-node');
                usingGpu = false;
                console.log('[face-recognition] Loaded CPU TensorFlow backend');
            }

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
                    detector: { enabled: true, maxDetected: 50, minConfidence: 0.1, rotation: true, return: true },
                    mesh: { enabled: true },
                    iris: { enabled: false },
                    description: { enabled: true },
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

            modelsLoaded = true;
            console.log(`[face-recognition] Human models loaded successfully (${usingGpu ? 'GPU' : 'CPU'})`);
            return true;
        } catch (err) {
            console.warn('[face-recognition] Failed to load models, disabling:', err.message);
            disabled = true;
            return false;
        } finally {
            modelLoadPromise = null;
        }
    })();

    return modelLoadPromise;
}

// ---- Detection ----

/**
 * Check if a file path has an image extension we can process.
 */
function isImageFile(filePath) {
    return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Detect all faces in an image and return their embeddings and bounding boxes.
 *
 * @param {string} imagePath - Absolute path to an image file
 * @returns {Promise<Array<{
 *   embedding: number[],
 *   box: { x: number, y: number, width: number, height: number },
 *   score: number
 * }>>}
 */
async function detectFaces(imagePath) {
    if (disabled || !isImageFile(imagePath)) return [];

    const ok = await initModels();
    if (!ok) return [];

    try {
        const inputSize = settings.inputSize;
        const { data, info } = await sharp(imagePath)
            .rotate()
            .resize(inputSize, inputSize, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const { width, height } = info;

        // Sync runtime settings into the Human config before each detect call
        human.config.face.detector.minConfidence = settings.minConfidence;
        human.config.face.detector.rotation = true;

        const tensor = human.tf.tidy(() => {
            const t3d = human.tf.tensor3d(new Uint8Array(data), [height, width, 3]);
            return human.tf.expandDims(t3d, 0);
        });

        const result = await human.detect(tensor);
        human.tf.dispose(tensor);

        const originalMeta = await sharp(imagePath).rotate().metadata();
        const scaleX = (originalMeta.width || width) / width;
        const scaleY = (originalMeta.height || height) / height;

        const minConf = settings.minConfidence;
        const rawCount = result.face ? result.face.length : 0;
        const withEmbedding = result.face ? result.face.filter(f => f.embedding && f.embedding.length > 0) : [];
        const aboveConf = withEmbedding.filter(f => (f.boxScore || f.score || 0) >= minConf);
        if (rawCount !== aboveConf.length) {
            console.log(`[face-recognition] ${path.basename(imagePath)}: raw=${rawCount}, withEmbedding=${withEmbedding.length}, aboveConf(${minConf})=${aboveConf.length}`);
            result.face.forEach((f, i) => {
                const score = (f.boxScore || f.score || 0).toFixed(3);
                const hasEmb = f.embedding && f.embedding.length > 0;
                if (!hasEmb || score < minConf) {
                    console.log(`[face-recognition]   dropped face ${i}: score=${score}, hasEmbedding=${hasEmb}`);
                }
            });
        }

        return aboveConf.map((f) => ({
                embedding: new Float32Array(f.embedding),
                box: {
                    x: f.box[0] * scaleX,
                    y: f.box[1] * scaleY,
                    width: f.box[2] * scaleX,
                    height: f.box[3] * scaleY,
                },
                score: f.boxScore || f.score || 0,
            }));
    } catch (err) {
        console.warn('[face-recognition] Error processing', imagePath, err.message);
        return [];
    }
}

// ---- Distance / Matching ----

/**
 * Euclidean distance between two face descriptor vectors.
 */
function euclideanDistance(a, b) {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

/**
 * Cosine similarity between two face descriptor vectors. Returns 0..1 (1 = identical).
 */
function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Normalized distance metric for face matching.
 * Uses the Human library's similarity approach internally but exposes
 * a distance-like value (lower = more similar) for backward compat.
 */
function faceDistance(a, b) {
    const sim = cosineSimilarity(a, b);
    return 1 - sim;
}

/**
 * Find the best matching identity for an embedding.
 *
 * @param {Float32Array|number[]} embedding - The face descriptor to match
 * @param {Array<{ id: string, descriptor: Float32Array|number[] }>} identities - Known identities
 * @param {number} [threshold] - Maximum distance to consider a match
 * @returns {{ identity: object, distance: number } | null}
 */
function findBestMatch(embedding, identities, threshold = settings.distanceThreshold) {
    let bestMatch = null;
    let bestDist = Infinity;

    for (const identity of identities) {
        const dist = faceDistance(embedding, identity.descriptor);
        if (dist < bestDist) {
            bestDist = dist;
            bestMatch = identity;
        }
    }

    if (bestMatch && bestDist <= threshold) {
        return { identity: bestMatch, distance: bestDist };
    }
    return null;
}

// ---- Agglomerative Clustering (Average Linkage / UPGMA) ----

/**
 * Compute pairwise cosine distance matrix using TF.js BLAS-accelerated matMul.
 * Processes in row-batches to avoid allocating a full [n,n] tensor that would
 * OOM for large n. Peak TF memory is bounded to ~(2·n·dim + BATCH·n) floats.
 *
 * Returns a flat Float32Array of length n*n where dist[i*n+j] = cosine distance.
 */
async function computeDistanceMatrix(items) {
    const n = items.length;
    const dim = items[0].descriptor.length;
    const raw = new Float32Array(n * dim);
    for (let i = 0; i < n; i++) raw.set(items[i].descriptor, i * dim);

    const BATCH = 512;
    const peakMB = ((2 * n * dim + BATCH * n) * 4) / (1024 * 1024);
    console.log(`[faces] distance matrix: n=${n}, dim=${dim}, batch=${BATCH}, est peak TF ~${peakMB.toFixed(0)}MB`);

    const normalized = tf.tidy(() => {
        const mat = tf.tensor2d(raw, [n, dim]);
        const norms = tf.norm(mat, 'euclidean', 1, true);
        return tf.div(mat, tf.add(norms, 1e-10));
    });

    const normalizedT = tf.transpose(normalized);
    const dist = new Float32Array(n * n);

    for (let i = 0; i < n; i += BATCH) {
        const end = Math.min(i + BATCH, n);
        const batchSize = end - i;

        const batchDist = tf.tidy(() => {
            const batch = tf.slice(normalized, [i, 0], [batchSize, dim]);
            const sim = tf.matMul(batch, normalizedT);
            return tf.sub(1, sim);
        });

        const batchData = await batchDist.data();
        batchDist.dispose();

        for (let r = 0; r < batchSize; r++) {
            dist.set(batchData.subarray(r * n, (r + 1) * n), (i + r) * n);
        }

        if (i % (BATCH * 4) === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    normalized.dispose();
    normalizedT.dispose();
    return dist;
}

/**
 * Pure-JS fallback for when TF is not loaded.
 */
function computeDistanceMatrixJS(items) {
    const n = items.length;
    const dist = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = faceDistance(items[i].descriptor, items[j].descriptor);
            dist[i * n + j] = d;
            dist[j * n + i] = d;
        }
    }
    return dist;
}

/**
 * Agglomerative clustering with average linkage (UPGMA) on a precomputed
 * flat n×n distance matrix. Merges the closest pair of clusters at each step,
 * stopping when the smallest inter-cluster distance exceeds the threshold.
 *
 * Uses nearest-neighbor pointers so each merge is O(n) amortized — the global
 * minimum is found in O(activeCount) via the NN array, and only clusters whose
 * NN was invalidated by the merge require a full rescan.
 *
 * Modifies `dist` in place for UPGMA distance updates.
 *
 * @param {number} n
 * @param {Float32Array} dist - Flat n×n distance matrix (modified in place)
 * @param {number} threshold
 * @returns {Promise<{ labels: Int32Array, numClusters: number, mergeCount: number }>}
 */
async function agglomerativeCluster(n, dist, threshold) {
    const yieldEvt = () => new Promise(r => setTimeout(r, 10));

    const active = new Uint8Array(n);
    active.fill(1);
    const clusterSize = new Float64Array(n);
    clusterSize.fill(1);

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }

    const nn = new Int32Array(n);
    const nnDist = new Float32Array(n);
    nn.fill(-1);
    nnDist.fill(Infinity);

    function computeNN(c) {
        let best = -1, bestD = Infinity;
        const off = c * n;
        for (let j = 0; j < n; j++) {
            if (j !== c && active[j]) {
                const d = dist[off + j];
                if (d < bestD) { bestD = d; best = j; }
            }
        }
        nn[c] = best;
        nnDist[c] = bestD;
    }

    for (let i = 0; i < n; i++) {
        computeNN(i);
        if (i % 2000 === 0 && i > 0) await yieldEvt();
    }

    let mergeCount = 0;
    let activeCount = n;

    while (activeCount > 1) {
        let bestA = -1, bestD = Infinity;
        for (let i = 0; i < n; i++) {
            if (active[i] && nnDist[i] < bestD) {
                bestD = nnDist[i];
                bestA = i;
            }
        }

        if (bestA === -1 || bestD > threshold) break;
        const bestB = nn[bestA];
        if (bestB === -1) break;

        const sA = clusterSize[bestA];
        const sB = clusterSize[bestB];
        const sNew = sA + sB;

        for (let k = 0; k < n; k++) {
            if (!active[k] || k === bestA || k === bestB) continue;
            const newD = (sA * dist[bestA * n + k] + sB * dist[bestB * n + k]) / sNew;
            dist[bestA * n + k] = newD;
            dist[k * n + bestA] = newD;
        }

        active[bestB] = 0;
        parent[bestB] = bestA;
        clusterSize[bestA] = sNew;
        activeCount--;

        computeNN(bestA);

        for (let k = 0; k < n; k++) {
            if (!active[k] || k === bestA) continue;
            if (nn[k] === bestB || nn[k] === bestA) {
                computeNN(k);
            } else {
                const dToMerged = dist[k * n + bestA];
                if (dToMerged < nnDist[k]) {
                    nn[k] = bestA;
                    nnDist[k] = dToMerged;
                }
            }
        }

        mergeCount++;
        if (mergeCount % 200 === 0) await yieldEvt();
    }

    const labels = new Int32Array(n);
    const rootToLabel = new Map();
    let nextLabel = 0;
    for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!rootToLabel.has(root)) rootToLabel.set(root, nextLabel++);
        labels[i] = rootToLabel.get(root);
    }

    return { labels, numClusters: nextLabel, mergeCount };
}

/**
 * Cluster face embeddings using agglomerative clustering with average linkage.
 * Uses TF.js matMul for the distance matrix (BLAS-accelerated) when available,
 * falls back to pure JS otherwise.
 *
 * @param {Array<{ id: string, descriptor: Float32Array|number[] }>} items
 * @param {number} [threshold] - Max average-linkage distance to merge two clusters
 * @returns {Promise<Array<Array<string>>>} Array of clusters, each an array of item IDs
 */
async function clusterFaces(items, threshold = settings.distanceThreshold) {
    const n = items.length;
    if (n === 0) return [];

    const matrixBytes = n * n * 4;
    const matrixMB = matrixBytes / (1024 * 1024);
    const MAX_MATRIX_MB = 512;
    if (matrixMB > MAX_MATRIX_MB) {
        console.warn(`[faces] distance matrix would be ${matrixMB.toFixed(0)}MB (${n}×${n}), exceeds ${MAX_MATRIX_MB}MB cap — truncating to newest faces`);
        const maxN = Math.floor(Math.sqrt((MAX_MATRIX_MB * 1024 * 1024) / 4));
        items = items.slice(-maxN);
        return clusterFaces(items, threshold);
    }

    const t0 = Date.now();
    let dist;
    if (tf && modelsLoaded) {
        dist = await computeDistanceMatrix(items);
        console.log(`[faces] distance matrix (${n}×${n}) via tf.matMul: ${Date.now() - t0}ms`);
    } else {
        dist = computeDistanceMatrixJS(items);
        console.log(`[faces] distance matrix (${n}×${n}) via JS fallback: ${Date.now() - t0}ms`);
    }

    await new Promise(r => setTimeout(r, 50));

    const t1 = Date.now();
    const { numClusters, labels, mergeCount } = await agglomerativeCluster(n, dist, threshold);
    console.log(`[faces] agglomerative clustering: ${Date.now() - t1}ms, ${numClusters} clusters (${mergeCount} merges)`);

    const clusterMap = new Map();
    for (let i = 0; i < n; i++) {
        const label = labels[i];
        if (!clusterMap.has(label)) clusterMap.set(label, []);
        clusterMap.get(label).push(items[i].id);
    }

    return Array.from(clusterMap.values());
}

// ---- Thumbnail Generation ----

/**
 * Crop a face from an image and save a thumbnail.
 *
 * @param {string} imagePath - Source image path
 * @param {{ x: number, y: number, width: number, height: number }} box - Face bounding box
 * @param {string} outputPath - Where to save the cropped thumbnail
 * @param {number} [size=96] - Output square size
 */
async function cropFaceThumbnail(imagePath, box, outputPath, size = 96) {
    try {
        const meta = await sharp(imagePath).rotate().metadata();
        let uprightW = meta.width || 100;
        let uprightH = meta.height || 100;

        if (meta.orientation >= 5 && meta.orientation <= 8) {
            uprightW = meta.height || 100;
            uprightH = meta.width || 100;
        }

        const realX = box.x * (uprightW / (meta.width || 100));
        const realY = box.y * (uprightH / (meta.height || 100));
        const realW = box.width * (uprightW / (meta.width || 100));
        const realH = box.height * (uprightH / (meta.height || 100));

        const padX = realW * 0.3;
        const padY = realH * 0.3;
        const left = Math.max(0, Math.round(realX - padX));
        const top = Math.max(0, Math.round(realY - padY));
        const right = Math.min(uprightW, Math.round(realX + realW + padX));
        const bottom = Math.min(uprightH, Math.round(realY + realH + padY));
        const w = right - left;
        const h = bottom - top;

        if (w <= 0 || h <= 0) return false;

        const cropSize = Math.max(w, h);
        const cx = left + w / 2;
        const cy = top + h / 2;
        const sqLeft = Math.max(0, Math.round(cx - cropSize / 2));
        const sqTop = Math.max(0, Math.round(cy - cropSize / 2));
        const sqW = Math.min(uprightW - sqLeft, Math.round(cropSize));
        const sqH = Math.min(uprightH - sqTop, Math.round(cropSize));

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        await sharp(imagePath)
            .rotate()
            .extract({ left: sqLeft, top: sqTop, width: sqW, height: sqH })
            .resize(size, size, { fit: 'cover' })
            .jpeg({ quality: 85 })
            .toFile(outputPath);

        return true;
    } catch (err) {
        console.warn('[face-recognition] Error cropping thumbnail:', err.message);
        return false;
    }
}

function isGpuAccelerated() {
    return usingGpu;
}

module.exports = {
    initModels,
    isImageFile,
    detectFaces,
    euclideanDistance,
    faceDistance,
    cosineSimilarity,
    findBestMatch,
    clusterFaces,
    cropFaceThumbnail,
    isGpuAccelerated,
    getSettings,
    updateSettings,
    DEFAULT_DISTANCE_THRESHOLD,
};
