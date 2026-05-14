import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { exec } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import Store from 'electron-store'

const execAsync = promisify(exec)

/** Directory of this file (`out/main` in dev/build). Not named `__dirname` — electron-vite injects its own. */
const mainDir = fileURLToPath(new URL('.', import.meta.url))
const preloadFile = existsSync(join(mainDir, '../preload/index.mjs'))
  ? 'index.mjs'
  : 'index.js'
const preloadPath = join(mainDir, '../preload', preloadFile)

type TrophyTier = 'gold' | 'silver' | 'bronze'

type StoredAchievement = {
  apiname: string
  displayName: string
  description: string
  achieved: boolean
  unlocktime: number
  globalPercent: number | null
  tier: TrophyTier
}

type StoreSchema = {
  steamId: string
  webApiKey: string
  appId: string
  lastAchievementsJson: string
  achievements: StoredAchievement[]
  overlayBounds: { x: number; y: number; width: number; height: number } | null
  startWithSteamWatch: boolean
}

const store = new Store<StoreSchema>({
  defaults: {
    steamId: '',
    webApiKey: '',
    appId: '',
    lastAchievementsJson: '',
    achievements: [],
    overlayBounds: null,
    startWithSteamWatch: true
  }
})

/** Dev-friendly: map root `.env` into empty store fields (app uses electron-store, not process.env for settings). */
function tryHydrateStoreFromDotEnv(): void {
  const envPath = join(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  let text: string
  try {
    text = readFileSync(envPath, 'utf8')
  } catch {
    return
  }
  const keyMap: Record<string, 'webApiKey' | 'steamId' | 'appId'> = {
    WEB_API_KEY: 'webApiKey',
    STEAM_ID: 'steamId',
    GAME_APP_ID: 'appId'
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    const storeKey = keyMap[k]
    if (!storeKey) continue
    if (!store.get(storeKey).trim()) store.set(storeKey, v)
  }
}

tryHydrateStoreFromDotEnv()

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let steamPollTimer: ReturnType<typeof setInterval> | null = null
let steamWatchTimer: ReturnType<typeof setInterval> | null = null
let steamWasRunning = false
let isQuitting = false

const TINY_TRAY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGD4z0ABYBw1YDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QDQ1QAAYYwT7vV6s6QAAAABJRU5ErkJggg=='

function isSteamRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    return execAsync('tasklist /FI "IMAGENAME eq steam.exe" /NH')
      .then(({ stdout }) => stdout.toLowerCase().includes('steam.exe'))
      .catch(() => false)
  }
  if (process.platform === 'darwin') {
    return execAsync('pgrep Steam')
      .then(() => true)
      .catch(() => false)
  }
  return execAsync('pgrep -x steam')
    .then(() => true)
    .catch(() => false)
}

function tierFromGlobalPercent(percent: number | null): TrophyTier {
  if (percent == null || Number.isNaN(percent)) return 'bronze'
  if (percent <= 5) return 'gold'
  if (percent <= 25) return 'silver'
  return 'bronze'
}

async function fetchGlobalPercents(appId: string): Promise<Map<string, number>> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(appId)}&format=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Global stats HTTP ${res.status}`)
  const data = (await res.json()) as {
    achievementpercentages?: { achievements?: { name: string; percent: number }[] }
  }
  const list = data.achievementpercentages?.achievements ?? []
  const map = new Map<string, number>()
  for (const a of list) map.set(a.name, a.percent)
  return map
}

async function fetchPlayerAchievements(
  key: string,
  steamId: string,
  appId: string
): Promise<
  {
    apiname: string
    achieved: number
    unlocktime: number
    name?: string
    description?: string
  }[]
> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appId)}&l=english`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Player achievements HTTP ${res.status}`)
  const data = (await res.json()) as {
    playerstats?: {
      success?: boolean
      achievements?: {
        apiname: string
        achieved: number
        unlocktime: number
        name?: string
        description?: string
      }[]
    }
  }
  if (!data.playerstats) throw new Error('Steam API returned no player stats')
  const list = data.playerstats.achievements ?? []
  if (data.playerstats.success === false && list.length === 0) {
    throw new Error('Could not read achievements (check Steam ID, App ID, and profile privacy).')
  }
  return list
}

async function fetchSchemaDisplay(
  key: string,
  appId: string
): Promise<Map<string, { displayName: string; description: string }>> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}&l=english`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Schema HTTP ${res.status}`)
  const data = (await res.json()) as {
    game?: {
      availableGameStats?: {
        achievements?: { name: string; displayName: string; description?: string }[]
      }
    }
  }
  const list = data.game?.availableGameStats?.achievements ?? []
  const map = new Map<string, { displayName: string; description: string }>()
  for (const a of list) {
    map.set(a.name, { displayName: a.displayName, description: a.description ?? '' })
  }
  return map
}

function mergeAchievements(
  player: Awaited<ReturnType<typeof fetchPlayerAchievements>>,
  globalMap: Map<string, number>,
  schemaMap: Map<string, { displayName: string; description: string }>
): StoredAchievement[] {
  return player.map((a) => {
    const pct = globalMap.get(a.apiname) ?? null
    const meta = schemaMap.get(a.apiname)
    return {
      apiname: a.apiname,
      displayName: meta?.displayName ?? a.name ?? a.apiname,
      description: meta?.description ?? a.description ?? '',
      achieved: a.achieved === 1,
      unlocktime: a.unlocktime,
      globalPercent: pct,
      tier: tierFromGlobalPercent(pct)
    }
  })
}

function broadcastNewUnlocks(previous: StoredAchievement[], next: StoredAchievement[]): void {
  const prevUnlocked = new Set(previous.filter((x) => x.achieved).map((x) => x.apiname))
  for (const a of next) {
    if (a.achieved && !prevUnlocked.has(a.apiname)) {
      overlayWindow?.webContents.send('trophy-unlock', {
        displayName: a.displayName,
        tier: a.tier,
        description: a.description
      })
      mainWindow?.webContents.send('trophy-unlock', {
        displayName: a.displayName,
        tier: a.tier,
        description: a.description
      })
    }
  }
}

async function refreshAchievements(): Promise<StoredAchievement[] | { error: string }> {
  const key = store.get('webApiKey').trim()
  const steamId = store.get('steamId').trim()
  const appId = store.get('appId').trim()
  if (!key || !steamId || !appId) {
    return { error: 'Set Steam Web API key, Steam ID, and App ID in settings.' }
  }
  try {
    const [globalMap, player, schemaMap] = await Promise.all([
      fetchGlobalPercents(appId),
      fetchPlayerAchievements(key, steamId, appId),
      fetchSchemaDisplay(key, appId)
    ])
    const previous = store.get('achievements')
    const merged = mergeAchievements(player, globalMap, schemaMap)
    broadcastNewUnlocks(previous, merged)
    store.set('achievements', merged)
    store.set('lastAchievementsJson', JSON.stringify(merged))
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('achievements:updated')
    }
    return merged
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: msg }
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 560,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(mainDir, '../renderer/index.html'))
  }
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createOverlayWindow(): void {
  const primary = screen.getPrimaryDisplay()
  const w = 320
  const h = Math.min(720, primary.workArea.height - 40)
  const saved = store.get('overlayBounds')
  const defaultX = primary.workArea.x + primary.workArea.width - w - 12
  const defaultY = primary.workArea.y + 12

  overlayWindow = new BrowserWindow({
    width: saved?.width ?? w,
    height: saved?.height ?? h,
    x: saved?.x ?? defaultX,
    y: saved?.y ?? defaultY,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 260,
    minHeight: 400,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: ['--psteam-overlay']
    }
  })
  bumpOverlayAboveGames(overlayWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
    const sep = base.includes('?') ? '&' : '?'
    void overlayWindow.loadURL(`${base}${sep}psteam=overlay#overlay`)
  } else {
    void overlayWindow.loadFile(join(mainDir, '../renderer/index.html'), {
      hash: 'overlay',
      query: { psteam: 'overlay' }
    })
  }

  overlayWindow.webContents.once('did-finish-load', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) bumpOverlayAboveGames(overlayWindow)
  })

  overlayWindow.on('moved', persistOverlayBounds)
  overlayWindow.on('resized', persistOverlayBounds)
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

function persistOverlayBounds(): void {
  if (!overlayWindow) return
  const b = overlayWindow.getBounds()
  store.set('overlayBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
}

/** Keep the panel above games where the OS allows it (not true exclusive fullscreen). */
function bumpOverlayAboveGames(win: BrowserWindow): void {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.moveTop()
}

function createTray(): void {
  const img = nativeImage.createFromBuffer(Buffer.from(TINY_TRAY_PNG, 'base64'))
  tray = new Tray(img)
  tray.setToolTip('PSteam trophies')
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show overlay',
      click: () => {
        if (!overlayWindow) createOverlayWindow()
        if (overlayWindow) {
          bumpOverlayAboveGames(overlayWindow)
          overlayWindow.show()
        }
        startSteamPolling()
      }
    },
    {
      label: 'Settings',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Refresh trophies',
      click: () => void refreshAchievements()
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function startSteamPolling(): void {
  if (steamPollTimer) clearInterval(steamPollTimer)
  steamPollTimer = setInterval(() => {
    void refreshAchievements()
  }, 60_000)
  void refreshAchievements()
}

function stopSteamPolling(): void {
  if (steamPollTimer) {
    clearInterval(steamPollTimer)
    steamPollTimer = null
  }
}

function ensureOverlayForSteam(running: boolean): void {
  if (!store.get('startWithSteamWatch')) return
  if (running && !overlayWindow) {
    createOverlayWindow()
    if (overlayWindow) {
      bumpOverlayAboveGames(overlayWindow)
      overlayWindow.show()
    }
    startSteamPolling()
  }
  if (!running && overlayWindow) {
    stopSteamPolling()
    overlayWindow.close()
    overlayWindow = null
  }
}

function applySteamLaunchMode(): void {
  if (steamWatchTimer) {
    clearInterval(steamWatchTimer)
    steamWatchTimer = null
  }
  stopSteamPolling()
  if (store.get('startWithSteamWatch')) {
    void isSteamRunning().then((running) => {
      steamWasRunning = running
      if (!running && overlayWindow) {
        stopSteamPolling()
        overlayWindow.close()
        overlayWindow = null
      }
      startSteamProcessWatch()
    })
  } else {
    steamWasRunning = false
    if (!overlayWindow) createOverlayWindow()
    if (overlayWindow) {
      bumpOverlayAboveGames(overlayWindow)
      overlayWindow.show()
    }
    startSteamPolling()
  }
}

function startSteamProcessWatch(): void {
  if (steamWatchTimer) clearInterval(steamWatchTimer)
  steamWatchTimer = setInterval(() => {
    void isSteamRunning().then((running) => {
      if (running && !steamWasRunning) {
        steamWasRunning = true
        ensureOverlayForSteam(true)
      } else if (!running && steamWasRunning) {
        steamWasRunning = false
        ensureOverlayForSteam(false)
      } else if (running) {
        steamWasRunning = true
      }
    })
  }, 3000)
  void isSteamRunning().then((running) => {
    steamWasRunning = running
    if (running) ensureOverlayForSteam(true)
  })
}

function settingsComplete(): boolean {
  return Boolean(
    store.get('steamId').trim() && store.get('webApiKey').trim() && store.get('appId').trim()
  )
}

app.whenReady().then(() => {
  createMainWindow()
  createTray()
  applySteamLaunchMode()
  if (!settingsComplete()) {
    mainWindow?.show()
  } else if (store.get('startWithSteamWatch')) {
    void isSteamRunning().then((steamOn) => {
      if (!steamOn) mainWindow?.show()
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  isQuitting = true
})

ipcMain.handle('store:get', (_e, key: keyof StoreSchema) => store.get(key))
ipcMain.handle('store:set', (_e, key: keyof StoreSchema, value: StoreSchema[keyof StoreSchema]) => {
  store.set(key, value as never)
  if (key === 'startWithSteamWatch') {
    applySteamLaunchMode()
  }
})
ipcMain.handle('achievements:refresh', () => refreshAchievements())
ipcMain.handle('overlay:close', () => {
  overlayWindow?.hide()
})
ipcMain.handle('app:open-settings', () => {
  mainWindow?.show()
  mainWindow?.focus()
})
