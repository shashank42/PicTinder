#!/usr/bin/env node
/**
 * Cross-platform run script: installs deps if needed, then starts the app
 * with license check skipped. Use this to verify "npm start" works on Windows
 * before tackling build issues.
 *
 * Run from repo root: node test-scripts/run.js
 * Or: npm run verify:start
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const hasNodeModules = fs.existsSync(path.join(projectRoot, 'node_modules'));

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  if (!hasNodeModules) {
    console.log('Installing dependencies...');
    await run('npm', ['install']);
  }

  console.log('Starting PicTinder (license check skipped)...');
  await run('npm', ['start'], { SKIP_LICENSE: '1' });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
