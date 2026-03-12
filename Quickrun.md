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

| | macOS | Windows |
|---|---|---|
| **Deploy mac build** | `npm run deploy:mac` | — |
| **Deploy win build** | — | `npm run deploy:win` |
| **Deploy both** | `npm run deploy` | `npm run deploy` |

- `deploy:mac` builds the signed/notarized DMG and uploads it to the server
- `deploy:win` builds the Windows exe and uploads it to the server
- `deploy` (no suffix) auto-detects platform — on macOS builds both, on Windows builds win only
- Requires `SSH_KEY`, `SERVER_USER`, `SERVER_IP` in `.env`
- macOS builds additionally require `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in `.env`
- On Windows, requires Git for Windows (provides bash)

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
npm run deploy         # auto-detect platform
npm run deploy:mac     # macOS only
npm run deploy:win     # Windows only
```