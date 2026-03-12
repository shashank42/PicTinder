#!/usr/bin/env node
/**
 * Cross-platform build-and-run: builds the Electron app for the current
 * platform, then launches the built artifact (portable exe or .app).
 *
 * Usage:  node test-scripts/build-and-run.js
 *    or:  npm run build:test
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n> ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: true,
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
    child.on('error', reject);
  });
}

function findFile(dir, pattern) {
  try {
    return fs.readdirSync(dir).find((f) => pattern.test(f));
  } catch { return null; }
}

async function main() {
  if (!fs.existsSync(path.join(projectRoot, 'node_modules'))) {
    console.log('Installing dependencies...');
    await run('npm', ['install']);
  }

  if (isWin) {
    console.log('\n=== Building for Windows ===');
    await run('npm', ['run', 'rebuild:win']);
    await run('npm', ['run', 'build:win']);

    console.log('\nBuild output:');
    const distDir = path.join(projectRoot, 'dist');
    const exe = findFile(distDir, /PicTinder.*\.exe$/i);
    if (exe) {
      const exePath = path.join(distDir, exe);
      console.log(`Launching ${exePath} ...`);
      spawn('cmd', ['/c', 'start', '', exePath], { cwd: projectRoot, detached: true, stdio: 'ignore' }).unref();
    } else {
      console.log('No .exe found in dist/. Check the build output above.');
    }
  } else if (isMac) {
    console.log('\n=== Building for macOS (unsigned) ===');
    await run('npm', ['run', 'build:mac', '--', '-c.mac.identity=null', '-c.mac.hardenedRuntime=false']);

    const distDir = path.join(projectRoot, 'dist');
    let appPath = null;
    for (const sub of fs.readdirSync(distDir).filter((d) => d.startsWith('mac'))) {
      const candidate = path.join(distDir, sub, 'PicTinder.app');
      if (fs.existsSync(candidate)) { appPath = candidate; break; }
    }
    if (appPath) {
      console.log(`\nLaunching ${appPath} ...`);
      spawn('xattr', ['-cr', appPath], { stdio: 'ignore' });
      spawn('open', [appPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      console.log('Mac .app not found in dist/. Check the build output above.');
    }
  } else {
    console.log('Linux build not configured. Run electron-builder manually.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
