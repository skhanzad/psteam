# PSteam

**PlayStation-style trophy overlay for Steam.** PSteam shows your Steam achievements in a floating panel with gold / silver / bronze tiers (from global rarity), optional platinum when you complete a game, auto-detection of the game you are playing, local caching, optional MongoDB sync, and a stats dashboard.

![PSteam logo — Steam-style trophy art](resources/logo.png)

### Trophies view

Per-game achievements with tier counts (gold / silver / bronze from global rarity) and platinum progress.

![PSteam trophies window](resources/trophies.png)

### Trophy dashboard

Cross-game summary, tier breakdowns, and per-game mini charts.

![PSteam trophy dashboard](resources/dashboard.png)

---

## What you need

| Requirement | Notes |
|---------------|--------|
| **Node.js** | **20 LTS** or newer (includes `npm`). [Download Node.js](https://nodejs.org/) |
| **Steam** | Installed and signed in on the same PC |
| **Steam Web API key** | Free from [Steam Community → API key](https://steamcommunity.com/dev/apikey) |
| **Your Steam ID (64-bit)** | Profile URL or sites like [steamid.io](https://steamid.io/) |

> **Privacy:** For “now playing” and achievements, set **Steam → Profile → Edit Profile → Privacy Settings → Game details** to **Public** so the Web API can read your data.

---

## 1. Get the code

```bash
git clone https://github.com/skhanzad/psteam.git psteam
cd psteam
```


If you downloaded a ZIP instead, unpack it and open a terminal in that folder.

---

## 2. Install dependencies

From the project root:

```bash
npm install
```

This installs Electron, React, the Steam persistence stack, optional MongoDB driver, charting for the dashboard, and build tooling.

---

## 3. (Optional) Prefill settings with `.env`

You can create a **`.env`** file in the project root so the first launch fills empty fields (values are copied into the app’s local store when missing):

```env
WEB_API_KEY=your_steam_web_api_key
STEAM_ID=76561198xxxxxxxx
GAME_APP_ID=1245620

# Optional — MongoDB for syncing trophy snapshots across machines
MONGODB_URI=mongodb+srv://user:pass@cluster.example.net
MONGODB_DATABASE=psteam
```

| Variable | Maps to |
|----------|---------|
| `WEB_API_KEY`, `STEAM_WEB_API_KEY`, `STEAM_API_KEY` | Steam Web API key |
| `STEAM_ID` | 64-bit Steam ID |
| `GAME_APP_ID`, `APP_ID`, `STEAM_APP_ID` | Numeric Steam **App ID** for the game |
| `MONGODB_URI`, `MONGODB_URL` | MongoDB connection string |
| `MONGODB_DB`, `MONGODB_DATABASE` | Database name (default idea: `psteam`) |

`.env` is for convenience only; the app still saves settings in **electron-store** (per user data directory). Do **not** commit real secrets—keep `.env` out of git if it contains keys.

---

## 4. Run in development

```bash
npm run dev
```

What happens:

1. **electron-vite** builds the main process, preload, and React UI in watch mode.
2. The **PSteam** window opens (settings if setup is incomplete, otherwise behavior depends on your options).
3. Use the **system tray** icon for **Show overlay**, **Settings**, **Refresh trophies**, and **Quit**.

**First-time checklist in Settings**

1. Paste your **Steam Web API key** and **Steam ID (64-bit)**.
2. Set **Game App ID** (or enable **Detect active Steam game** and launch a game with public game details).
3. Click **Save & refresh** to pull achievements from Steam.
4. Optionally set **MongoDB URI** / database name for cloud backup of cached trophies.
5. Use **Trophy dashboard** (hash `#dashboard`) for cross-game charts and stats.

---

## 5. Build for production

```bash
npm run build
```

Output goes under **`out/`**:

| Path | Role |
|------|------|
| `out/main/` | Electron main process |
| `out/preload/` | Preload script |
| `out/renderer/` | Static UI (HTML/CSS/JS) |

### Run the built app

From the repo root after a successful build:

```bash
npx electron .
```

Or point Electron at the compiled main file your packaging tool expects (`package.json` field `"main": "out/main/index.js"`).

### Preview the production bundle (optional)

```bash
npm run preview
```

Uses **electron-vite preview** to run the production build locally.

### Release bundle (`electron-builder`)

Ship a **Windows** portable app and a zip archive (no NSIS installer in the default config—portable is friendlier for quick distribution and avoids some Windows toolchain issues):

```bash
npm run dist
```

(`npm run release` runs the same command.)

This runs **`npm run build`** first, then **electron-builder**. Output is under **`release/`**:

| Artifact | Description |
|----------|-------------|
| **`PSteam-<version>-win-x64.exe`** | Portable executable — no install step; double-click to run. |
| **`PSteam-<version>-win-x64.zip`** | Same app as a zip (handy for uploads or antivirus-friendly sharing). |
| **`win-unpacked/`** | Unpacked app directory (useful for debugging or custom packaging). |

The build is **not code-signed** by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`). For production signing, see the [electron-builder code signing](https://www.electron.build/code-signing) docs and adjust the `build` section in `package.json`.

On **macOS** or **Linux**, run `npm run dist` on that platform to produce the **DMG/ZIP** or **AppImage** targets defined in `package.json`.

---

## 6. Daily use (short)

1. **Start Steam** and your game (if you use auto-detect).
2. Open the **overlay** from the tray (**Show overlay**) or enable **Open overlay when Steam starts** in settings.
3. Trophies refresh on a timer; use **Refresh** in the overlay header or tray for a forced Steam API refresh.
4. **Compact** mode shrinks the overlay to a strip; **×** hides it (tray opens it again).

---

## 7. Optional features

### MongoDB

If **MongoDB URI** is set in settings (or via `.env`), PSteam upserts:

- **`last_game_cache`** — last detected game for quick recovery when Steam presence is unavailable.
- **`trophy_games`** — per `(Steam ID, App ID)` merged trophy snapshots.

**JSON files** under the app user data folder are still written as a **fallback** when MongoDB is off or unreachable.

### Trophy dashboard

In **Settings**, click **Trophy dashboard** (or open the main window with URL hash **`#dashboard`**). You’ll see aggregate pies (progress, tier totals), a stacked bar for unlocked vs locked by tier, and per-game cards with mini charts. Data comes from cached games for the **current Steam ID** in settings.

---

## 8. Troubleshooting

| Issue | What to try |
|--------|-------------|
| **No achievements / errors** | Confirm API key, 64-bit Steam ID, correct **App ID**, and **Game details: Public**. |
| **“No Steam game detected”** | Launch a Steam game, or turn off auto-detect and enter **App ID** manually (store URL number). |
| **Overlay blank or flashes** | Use **Save & refresh** after fixing settings; ensure the game has achievements on Steam. |
| **MongoDB errors** | Check URI, network, Atlas IP allowlist, and user permissions. The app continues with **file-only** cache. |
| **`npm install` fails** | Use Node 20+; delete `node_modules` and `package-lock.json`, then `npm install` again. |

---

## 9. Scripts reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Development mode with hot reload |
| `npm run build` | Production build to `out/` |
| `npm run preview` | Run the production build locally |
| `npm run dist` | Build + package installers/portables into `release/` |
| `npm run release` | Same as `npm run dist` |

---

## 10. Repository layout (overview)

```
psteam/
├── src/
│   ├── main/           # Electron main — Steam API, windows, tray, IPC, persistence
│   ├── preload/        # Secure bridge for the renderer
│   └── renderer/       # React UI — settings, overlay, dashboard
├── resources/          # Icons (PNG) + README screenshots (logo, trophies, dashboard)
├── out/                # Created by `npm run build` (gitignored)
├── release/            # Created by `npm run dist` — installers / portable (gitignored)
├── electron.vite.config.ts
├── package.json
└── README.md
```

---

**Enjoy your trophies.** If something breaks, check the terminal where you ran `npm run dev` or Electron—main-process logs are prefixed with `[psteam]` where relevant.
