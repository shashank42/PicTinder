Here's the full command reference:

### Development (run the app)

| | macOS | Windows |
|---|---|---|
| **Install deps** | `npm install` | `npm install` |
| **Rebuild native modules** | `npm run rebuild` | `npm run rebuild:win` |
| **Start app** | `npm start` | `npm start` |
| **Start app (skip license)** | `npm run run:dev` | `npm run run:dev` |

### Build (create distributable)

| | macOS | Windows |
|---|---|---|
| **Build installer** | `npm run build:mac` | `npm run build:win` |
| **Build + launch (test)** | `npm run build:test` | `npm run build:test` |

- `build:mac` produces a `.dmg` + `.zip` in `dist/`
- `build:win` produces `PicTinder Setup 1.0.0.exe` (NSIS installer) + `PicTinder 1.0.0.exe` (portable) in `dist/`
- `build:test` detects the platform automatically, builds, and launches the result

### Deploy (build + upload to server)

This is a bash script (run from Git Bash on Windows, or Terminal on macOS):

```bash
./scripts/build-and-deploy-app
```

- **On macOS**: builds the signed/notarized DMG, attempts a Windows cross-compile, uploads both DMG and exe to the server via SCP
- **On Windows**: builds the Windows exe only, uploads it to the server via SCP
- Requires `SSH_KEY`, `SERVER_USER`, `SERVER_IP` in `.env`
- macOS builds additionally require `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in `.env`

### Quick reference (copy-paste)

```bash
# First time setup (both platforms)
npm install
npm run rebuild:win    # Windows only — patches node-gyp for VS 2026

# Day-to-day dev
npm run run:dev

# Build
npm run build:win      # Windows
npm run build:mac      # macOS

# Build + deploy to server
./scripts/build-and-deploy-app
```