#!/usr/bin/env node
/**
 * On Windows: patch node-gyp to support VS 2026, set up the Visual Studio
 * developer environment, then run electron-rebuild.
 *
 * Run from repo root: node scripts/run-rebuild-with-vs.js
 * Or: npm run rebuild:win
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
const projectRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Patch node-gyp to recognise Visual Studio 2026 (internal version 18)
// ---------------------------------------------------------------------------

function patchNodeGyp() {
  const findVsPath = path.join(
    projectRoot, 'node_modules', 'node-gyp', 'lib', 'find-visualstudio.js'
  );
  if (!fs.existsSync(findVsPath)) {
    console.warn('node-gyp find-visualstudio.js not found — skipping patch');
    return;
  }

  let src = fs.readFileSync(findVsPath, 'utf8');
  if (src.includes('versionYear = 2026')) {
    console.log('node-gyp already patched for VS 2026');
    return;
  }

  // (a) getVersionInfo: add major 18 → year 2026
  src = src.replace(
    /if \(ret\.versionMajor === 17\) \{\s*ret\.versionYear = 2022\s*return ret\s*\}/,
    `if (ret.versionMajor === 17) {\n      ret.versionYear = 2022\n      return ret\n    }\n    if (ret.versionMajor === 18) {\n      ret.versionYear = 2026\n      return ret\n    }`
  );

  // (b) supportedYears arrays: add 2026 wherever [2019, 2022] appears
  src = src.replace(/\[2019, 2022\]/g, '[2019, 2022, 2026]');

  // (c) getToolset: add toolset for 2026 (v145 — MSVC 14.50)
  src = src.replace(
    /else if \(versionYear === 2022\) \{\s*return 'v143'\s*\}/,
    `else if (versionYear === 2022) {\n      return 'v143'\n    } else if (versionYear === 2026) {\n      return 'v145'\n    }`
  );

  fs.writeFileSync(findVsPath, src, 'utf8');
  console.log('Patched node-gyp to support Visual Studio 2026');
}

// ---------------------------------------------------------------------------
// 2. Locate VsDevCmd.bat
// ---------------------------------------------------------------------------

const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const vsBase = path.join(programFilesX86, 'Microsoft Visual Studio');

const VS_PATHS = [
  path.join(vsBase, '18', 'BuildTools', 'Common7', 'Tools', 'VsDevCmd.bat'),
  path.join(vsBase, '2022', 'BuildTools', 'Common7', 'Tools', 'VsDevCmd.bat'),
  path.join(vsBase, '2022', 'Community', 'Common7', 'Tools', 'VsDevCmd.bat'),
  path.join(vsBase, '2022', 'Professional', 'Common7', 'Tools', 'VsDevCmd.bat'),
  path.join(vsBase, '2022', 'Enterprise', 'Common7', 'Tools', 'VsDevCmd.bat'),
];

function findVsDevCmd() {
  for (const p of VS_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Run electron-rebuild
// ---------------------------------------------------------------------------

function runRebuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['electron-rebuild'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    child.on('error', reject);
  });
}

function runRebuildWithVs(vsDevCmd) {
  const batPath = path.join(projectRoot, 'scripts', 'pictinder-rebuild.bat');
  const batContent = [
    '@echo off',
    `call "${vsDevCmd}" -arch=amd64`,
    `cd /d "${projectRoot}"`,
    'npx electron-rebuild',
  ].join('\r\n');

  fs.writeFileSync(batPath, batContent, 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('cmd', ['/c', batPath], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    });
    function done(code) {
      try { fs.unlinkSync(batPath); } catch (_) {}
      if (code === 0) resolve(); else reject(new Error(`Exit ${code}`));
    }
    child.on('close', done);
    child.on('error', (err) => {
      try { fs.unlinkSync(batPath); } catch (_) {}
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (isWindows) {
    patchNodeGyp();
  }

  if (!isWindows) {
    await runRebuild();
    return;
  }

  const vsDevCmd = findVsDevCmd();
  if (vsDevCmd) {
    console.log('Using Visual Studio developer environment:', vsDevCmd);
    await runRebuildWithVs(vsDevCmd);
  } else {
    console.warn('VsDevCmd.bat not found — running electron-rebuild without VS environment.');
    console.warn('If it fails, open "Developer Command Prompt for VS 2026" and run: npm run rebuild');
    await runRebuild();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
