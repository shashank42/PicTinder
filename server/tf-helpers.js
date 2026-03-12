'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Build a file:// URL from an absolute filesystem path.
 * Works on both Windows (backslash paths) and macOS/Linux (forward slash paths).
 */
function pathToFileUrl(fsPath) {
  return 'file://' + fsPath.replace(/\\/g, '/');
}

/**
 * Returns the file:// base URL pointing to the @vladmandic/human models dir.
 */
function getHumanModelBasePath() {
  const modelsDir = path.join(__dirname, '..', 'node_modules', '@vladmandic', 'human', 'models');
  return pathToFileUrl(modelsDir) + '/';
}

/**
 * On Windows, tensorflow.dll is in deps/lib/ and must be on PATH before
 * the native binding is loaded. Call this once before require('tfjs-node').
 */
function ensureTfjsDllPath() {
  if (process.platform !== 'win32') return;
  const tfjsDepsLib = path.join(__dirname, '..', 'node_modules', '@tensorflow', 'tfjs-node', 'deps', 'lib');
  if (fs.existsSync(tfjsDepsLib) && !process.env.PATH.includes(tfjsDepsLib)) {
    process.env.PATH = tfjsDepsLib + ';' + process.env.PATH;
  }
}

/**
 * Load the TensorFlow backend (GPU first, then CPU).
 * Returns { tf, usingGpu }.
 */
function loadTfBackend() {
  ensureTfjsDllPath();
  try {
    const tf = require('@tensorflow/tfjs-node-gpu');
    return { tf, usingGpu: true };
  } catch {
    const tf = require('@tensorflow/tfjs-node');
    return { tf, usingGpu: false };
  }
}

module.exports = { pathToFileUrl, getHumanModelBasePath, ensureTfjsDllPath, loadTfBackend };
