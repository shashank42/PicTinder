#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

export APPLE_ID="devo.shanky@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="pxiu-dumr-ccpo-mbex"
export APPLE_TEAM_ID="9Z83RNNA48"

echo ""
echo "=== Building for macOS ==="
npm run build:mac

echo ""
echo "=== Building for Windows ==="
npm run build:win

echo ""
echo "Build output is in ./dist/"
ls -1 dist/*.dmg dist/*.zip dist/*.exe 2>/dev/null || true

# Run the Mac app if we're on macOS
if [[ "$OSTYPE" == darwin* ]]; then
  APP=$(find dist/mac* -name "Pictinder.app" -maxdepth 2 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    echo ""
    echo "Launching $APP ..."
    open "$APP"
  else
    echo "Mac .app not found in dist/. Open it manually from dist/."
  fi
else
  echo "Not on macOS — run the Windows installer from dist/ manually."
fi
