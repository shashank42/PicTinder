const path = require('path');
const { rcedit } = require('rcedit');

/**
 * electron-builder afterPack hook.
 * When signAndEditExecutable is false (to skip winCodeSign download),
 * the icon doesn't get embedded. This hook runs rcedit manually to
 * set the icon on the Windows exe after packaging.
 */
module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');

  console.log(`  • afterPack: embedding icon into ${path.basename(exePath)}`);
  await rcedit(exePath, { icon: icoPath });
};
