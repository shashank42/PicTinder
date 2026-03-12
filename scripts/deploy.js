#!/usr/bin/env node
/**
 * Cross-platform wrapper for scripts/build-and-deploy-app.
 * Accepts an optional platform argument: mac, win, or omit for auto.
 *
 * Usage:  node scripts/deploy.js [mac|win]
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'build-and-deploy-app');
const platform = process.argv[2] || '';

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'bash';
}

const bash = findBash();
const args = [script];
if (platform) args.push(platform);

const child = spawn(bash, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code || 0));
child.on('error', (err) => {
  console.error(`Failed to run deploy script: ${err.message}`);
  if (process.platform === 'win32') {
    console.error('Make sure Git for Windows is installed (provides bash).');
  }
  process.exit(1);
});
