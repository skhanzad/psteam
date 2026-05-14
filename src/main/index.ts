import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { exec } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import Store from 'electron-store'
import * as persist from './persistence'
import { trophyRecordToDashboardStats, type DashboardGameStats } from './dashboard'

const execAsync = promisify(exec)

/** Directory of this file (`out/main` in dev/build). Not named `__dirname` — electron-vite injects its own. */
const mainDir = fileURLToPath(new URL('.', import.meta.url))
const preloadFile = existsSync(join(mainDir, '../preload/index.mjs'))
  ? 'index.mjs'
  : 'index.js'
const preloadPath = join(mainDir, '../preload', preloadFile)

/** Project `resources/` folder (repo root). Put `tray.png`, `icon.png`, or `logo.png` here (PNG or ICO). */
const resourcesDir = join(mainDir, '../../resources')

const APP_ICON_FILES = ['tray.png', 'icon.png', 'logo.png'] as const

function findAppIconPath(): string | null {
  for (const name of APP_ICON_FILES) {
    const p = join(resourcesDir, name)
    if (existsSync(p)) return p
  }
  return null
}

/** Tray: small square; prefers file from `resources/`. */
function loadTrayImage(): Electron.NativeImage {
  const p = findAppIconPath()
  if (p) {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) {
      const traySize = process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 22
      return img.resize({ width: traySize, height: traySize })
    }
  }
  return nativeImage.createFromBuffer(Buffer.from(TINY_TRAY_PNG, 'base64'))
}

/** Taskbar / window icon (Windows/Linux); path from `resources/` or undefined. */
function getWindowIconPath(): string | undefined {
  return findAppIconPath() ?? undefined
}

type TrophyTier = 'gold' | 'silver' | 'bronze' | 'platinum'

type StoredAchievement = {
  apiname: string
  displayName: string
  description: string
  achieved: boolean
  unlocktime: number
  globalPercent: number | null
  tier: TrophyTier
  /** Steam CDN (GetSchemaForGame) — unlocked art */
  icon?: string
  /** Steam CDN — locked / grayscale art */
  iconGray?: string
}

type StoreSchema = {
  steamId: string
  webApiKey: string
  appId: string
  lastAchievementsJson: string
  achievements: StoredAchievement[]
  overlayBounds: { x: number; y: number; width: number; height: number } | null
  startWithSteamWatch: boolean
  /** 0.2–1.0; whole overlay window (Steam trophy panel). */
  overlayOpacity: number
  /** True = thin strip; window stays on-screen (not OS minimize). */
  overlayCompact: boolean
  /** Bounds before entering compact (restored on expand). */
  overlayExpandedBounds: { x: number; y: number; width: number; height: number } | null
  /** When true, `appId` is filled from Steam “currently playing” (GetPlayerSummaries). */
  autoDetectGame: boolean
  /** Last non-empty title from presence (for settings hint). */
  detectedGameName: string
  /** Optional MongoDB connection (e.g. mongodb+srv://…). Empty = file-only persistence. */
  mongoUri: string
  /** MongoDB database name when `mongoUri` is set. */
  mongoDbName: string
}

const store = new Store<StoreSchema>({
  defaults: {
    steamId: '',
    webApiKey: '',
    appId: '',
    lastAchievementsJson: '',
    achievements: [],
    overlayBounds: null,
    startWithSteamWatch: true,
    overlayOpacity: 1,
    overlayCompact: false,
    overlayExpandedBounds: null,
    autoDetectGame: true,
    detectedGameName: '',
    mongoUri: '',
    mongoDbName: 'psteam'
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
  const keyMap: Record<string, 'webApiKey' | 'steamId' | 'appId' | 'mongoUri' | 'mongoDbName'> = {
    WEB_API_KEY: 'webApiKey',
    STEAM_WEB_API_KEY: 'webApiKey',
    STEAM_API_KEY: 'webApiKey',
    STEAM_ID: 'steamId',
    GAME_APP_ID: 'appId',
    APP_ID: 'appId',
    STEAM_APP_ID: 'appId',
    MONGODB_URI: 'mongoUri',
    MONGODB_URL: 'mongoUri',
    MONGODB_DB: 'mongoDbName',
    MONGODB_DATABASE: 'mongoDbName'
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim().replace(/^\uFEFF/, '')
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    const storeKey = keyMap[k]
    if (!storeKey) continue
    const cur = store.get(storeKey)
    const empty = typeof cur === 'string' ? !cur.trim() : cur == null || cur === ''
    if (empty) store.set(storeKey, v as never)
  }
}

tryHydrateStoreFromDotEnv()

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let steamPollTimer: ReturnType<typeof setInterval> | null = null
let gamePresenceTimer: ReturnType<typeof setInterval> | null = null
let steamWatchTimer: ReturnType<typeof setInterval> | null = null
let steamWasRunning = false
let isQuitting = false

function clampOverlayOpacity(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw))
  if (!Number.isFinite(n)) return 1
  return Math.min(1, Math.max(0.2, n))
}

function applyOverlayOpacity(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setOpacity(clampOverlayOpacity(store.get('overlayOpacity')))
}

const OVERLAY_COMPACT_HEIGHT = 64

function emitOverlayCompactState(): void {
  const compact = Boolean(store.get('overlayCompact'))
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:compact-changed', compact)
  }
}

function applyOverlayCompactLayout(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const compact = Boolean(store.get('overlayCompact'))
  const b = overlayWindow.getBounds()

  if (compact) {
    if (b.height > OVERLAY_COMPACT_HEIGHT + 24) {
      store.set('overlayExpandedBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
    }
    overlayWindow.setResizable(false)
    overlayWindow.setMinimumSize(260, OVERLAY_COMPACT_HEIGHT)
    const width = Math.max(260, b.width)
    overlayWindow.setBounds(
      { x: b.x, y: b.y, width, height: OVERLAY_COMPACT_HEIGHT },
      true
    )
  } else {
    overlayWindow.setMinimumSize(260, 400)
    overlayWindow.setResizable(true)
    const exp = store.get('overlayExpandedBounds')
    const ob = store.get('overlayBounds')
    const target =
      exp && exp.width >= 260 && exp.height >= 400
        ? exp
        : ob && ob.width >= 260 && ob.height >= 400
          ? ob
          : null
    if (target) {
      overlayWindow.setBounds(
        { x: target.x, y: target.y, width: target.width, height: target.height },
        true
      )
      store.set('overlayBounds', {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height
      })
    } else {
      overlayWindow.setBounds({ x: b.x, y: b.y, width: 320, height: 520 }, true)
    }
  }
  applyOverlayOpacity()
  bumpOverlayAboveGames(overlayWindow)
  emitOverlayCompactState()
}

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

function parseSteamPercent(raw: number | string | undefined | null): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function tierFromGlobalPercent(percent: number | string | null | undefined): TrophyTier {
  const n = parseSteamPercent(percent)
  if (n == null) return 'bronze'
  if (n <= 5) return 'gold'
  if (n <= 25) return 'silver'
  return 'bronze'
}

/** Steam sometimes rejects anonymous / Node default user agents; use a normal browser UA. */
const STEAM_FETCH_INIT: RequestInit = {
  headers: {
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  }
}

function achievementUnlocked(raw: number | boolean | string | undefined): boolean {
  return raw === true || raw === 1 || raw === '1'
}

/** Logs to the terminal that runs Electron (main process). Long achievement arrays are truncated. */
function deepTruncateForLog(value: unknown, maxRows: number, depth = 0): unknown {
  if (depth > 14) return value
  if (Array.isArray(value)) {
    const first = value[0]
    const looksLikeLongList =
      value.length > maxRows &&
      first &&
      typeof first === 'object' &&
      first !== null &&
      ('apiname' in first || ('name' in first && 'percent' in first) || 'displayName' in first)
    if (looksLikeLongList) {
      return [
        ...value.slice(0, maxRows).map((x) => deepTruncateForLog(x, maxRows, depth + 1)),
        `… ${value.length - maxRows} more rows`
      ]
    }
    return value.map((x) => deepTruncateForLog(x, maxRows, depth + 1))
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) {
      out[k] = deepTruncateForLog(v, maxRows, depth + 1) as unknown
    }
    return out
  }
  return value
}

function logSteamFetched(label: string, body: unknown): void {
  const clipped = deepTruncateForLog(body, 50)
  console.log(`[psteam:steam] ${label}:\n${JSON.stringify(clipped, null, 2)}`)
}

async function fetchGlobalPercents(appId: string): Promise<Map<string, number>> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${encodeURIComponent(appId)}&format=json`
  const res = await fetch(url, STEAM_FETCH_INIT)
  if (!res.ok) throw new Error(`Global stats HTTP ${res.status}`)
  const data = (await res.json()) as {
    achievementpercentages?: { achievements?: { name: string; percent: number | string }[] }
  }
  logSteamFetched(`GetGlobalAchievementPercentagesForApp (appid=${appId})`, data)
  const list = data.achievementpercentages?.achievements ?? []
  const map = new Map<string, number>()
  for (const a of list) {
    const p = parseSteamPercent(a.percent)
    if (p != null) map.set(a.name, p)
  }
  return map
}

async function fetchPlayerAchievements(
  key: string,
  steamId: string,
  appId: string
): Promise<
  {
    apiname: string
    achieved: number | boolean | string
    unlocktime: number
    name?: string
    description?: string
  }[]
> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId)}&appid=${encodeURIComponent(appId)}&l=english`
  const res = await fetch(url, STEAM_FETCH_INIT)
  if (!res.ok) throw new Error(`Player achievements HTTP ${res.status}`)
  const data = (await res.json()) as {
    playerstats?: {
      success?: boolean
      error?: string
      achievements?: {
        apiname: string
        achieved: number | boolean | string
        unlocktime: number
        name?: string
        description?: string
      }[]
    }
  }
  logSteamFetched(`GetPlayerAchievements (steamid=${steamId} appid=${appId})`, data)
  const ps = data.playerstats
  if (!ps) throw new Error('Steam API returned no player stats')
  if (typeof ps.error === 'string' && ps.error.trim()) {
    throw new Error(ps.error.trim())
  }
  const list = ps.achievements ?? []
  if (ps.success === false && list.length === 0) {
    throw new Error(
      'Could not read achievements (check Steam ID, App ID, and Steam profile privacy: Game details must be public).'
    )
  }
  return list
}

/** Steam “currently playing” (requires profile game details public). */
async function fetchCurrentlyPlayedGame(key: string, steamId: string): Promise<{ appId: string; name: string } | null> {
  const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`
  const res = await fetch(url, STEAM_FETCH_INIT)
  if (!res.ok) throw new Error(`Player summary HTTP ${res.status}`)
  const data = (await res.json()) as {
    response?: { players?: { gameid?: string; gameextrainfo?: string }[] }
  }
  const p = data.response?.players?.[0]
  if (!p) return null
  const gid = typeof p.gameid === 'string' ? p.gameid.trim() : String(p.gameid ?? '').trim()
  if (!gid || gid === '0') return null
  if (!/^\d+$/.test(gid)) return null
  const name = (p.gameextrainfo && String(p.gameextrainfo).trim()) || `App ${gid}`
  return { appId: gid, name }
}

async function hydrateLastGameFromCacheIfNeeded(): Promise<void> {
  if (!store.get('autoDetectGame')) return
  if (store.get('appId').trim()) return
  const steamId = store.get('steamId').trim()
  if (!steamId) return
  const c = await persist.readLastGameCache()
  if (c && c.steamId === steamId && c.appId.trim()) {
    store.set('appId', c.appId.trim())
    if (c.gameName) store.set('detectedGameName', c.gameName)
  }
}

async function syncActiveGameFromPresence(): Promise<boolean> {
  if (!store.get('autoDetectGame')) return false
  const key = store.get('webApiKey').trim()
  const steamId = store.get('steamId').trim()
  if (!key || !steamId) return false
  try {
    const g = await fetchCurrentlyPlayedGame(key, steamId)
    if (!g) return false
    store.set('detectedGameName', g.name)
    await persist.writeLastGameCache({
      steamId,
      appId: g.appId,
      gameName: g.name,
      updatedAt: Date.now()
    })
    const prev = store.get('appId').trim()
    if (g.appId !== prev) {
      store.set('appId', g.appId)
      return true
    }
    return false
  } catch {
    const c = await persist.readLastGameCache()
    if (c && c.steamId === steamId && c.appId.trim() && !store.get('appId').trim()) {
      store.set('appId', c.appId.trim())
      if (c.gameName) store.set('detectedGameName', c.gameName)
    }
    return false
  }
}

async function fetchSchemaDisplay(
  key: string,
  appId: string
): Promise<Map<string, { displayName: string; description: string; icon?: string; icongray?: string }>> {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}&l=english`
  const res = await fetch(url, STEAM_FETCH_INIT)
  if (!res.ok) throw new Error(`Schema HTTP ${res.status}`)
  const data = (await res.json()) as {
    game?: {
      availableGameStats?: {
        achievements?: {
          name: string
          displayName: string
          description?: string
          icon?: string
          icongray?: string
        }[]
      }
    }
  }
  logSteamFetched(`GetSchemaForGame (appid=${appId})`, data)
  const list = data.game?.availableGameStats?.achievements ?? []
  const map = new Map<string, { displayName: string; description: string; icon?: string; icongray?: string }>()
  for (const a of list) {
    map.set(a.name, {
      displayName: a.displayName,
      description: a.description ?? '',
      icon: a.icon,
      icongray: a.icongray
    })
  }
  return map
}

function mergeAchievements(
  player: Awaited<ReturnType<typeof fetchPlayerAchievements>>,
  globalMap: Map<string, number>,
  schemaMap: Map<string, { displayName: string; description: string; icon?: string; icongray?: string }>
): StoredAchievement[] {
  if (player.length > 0) {
    return player.map((a) => {
      const pct = globalMap.get(a.apiname) ?? null
      const meta = schemaMap.get(a.apiname)
      return {
        apiname: a.apiname,
        displayName: meta?.displayName ?? a.name ?? a.apiname,
        description: meta?.description ?? a.description ?? '',
        achieved: achievementUnlocked(a.achieved),
        unlocktime: a.unlocktime,
        globalPercent: pct,
        tier: tierFromGlobalPercent(pct),
        icon: meta?.icon,
        iconGray: meta?.icongray
      }
    })
  }

  /** Player list empty but schema exists (e.g. odd API edge) — still show all trophies as locked. */
  if (schemaMap.size > 0) {
    const out: StoredAchievement[] = []
    for (const apiname of schemaMap.keys()) {
      const meta = schemaMap.get(apiname)!
      const pct = globalMap.get(apiname) ?? null
      out.push({
        apiname,
        displayName: meta.displayName,
        description: meta.description,
        achieved: false,
        unlocktime: 0,
        globalPercent: pct,
        tier: tierFromGlobalPercent(pct),
        icon: meta.icon,
        iconGray: meta.icongray
      })
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /** No schema row — build from global stats (no key required for global; often still lists achievements). */
  if (globalMap.size > 0) {
    return [...globalMap.entries()]
      .map(([apiname, pct]) => ({
        apiname,
        displayName: apiname,
        description: '',
        achieved: false,
        unlocktime: 0,
        globalPercent: pct,
        tier: tierFromGlobalPercent(pct)
      }))
      .sort((a, b) => a.apiname.localeCompare(b.apiname))
  }

  return []
}

function allAchievementsUnlocked(list: StoredAchievement[]): boolean {
  return list.length > 0 && list.every((x) => x.achieved)
}

function broadcastNewUnlocks(previous: StoredAchievement[], next: StoredAchievement[]): void {
  const prevUnlocked = new Set(previous.filter((x) => x.achieved).map((x) => x.apiname))
  let newIndividualUnlock = false
  for (const a of next) {
    if (a.achieved && !prevUnlocked.has(a.apiname)) {
      newIndividualUnlock = true
      const iconUrl = a.icon || a.iconGray
      overlayWindow?.webContents.send('trophy-unlock', {
        displayName: a.displayName,
        tier: a.tier,
        description: a.description,
        iconUrl
      })
      mainWindow?.webContents.send('trophy-unlock', {
        displayName: a.displayName,
        tier: a.tier,
        description: a.description,
        iconUrl
      })
    }
  }

  const prevComplete = allAchievementsUnlocked(previous)
  const nextComplete = allAchievementsUnlocked(next)
  if (!nextComplete || prevComplete) return

  const platinumPayload = {
    displayName: 'Platinum Trophy',
    tier: 'platinum' as const,
    description: 'Unlocked every Steam achievement for this game.',
    iconUrl: undefined as string | undefined
  }
  const emitPlatinum = (): void => {
    overlayWindow?.webContents.send('trophy-unlock', platinumPayload)
    mainWindow?.webContents.send('trophy-unlock', platinumPayload)
  }
  /** After the last regular trophy toast so the platinum celebration is visible. */
  if (newIndividualUnlock) setTimeout(emitPlatinum, 5300)
  else emitPlatinum()
}

function publishAchievements(merged: StoredAchievement[]): StoredAchievement[] {
  const previous = store.get('achievements')
  broadcastNewUnlocks(previous, merged)
  store.set('achievements', merged)
  store.set('lastAchievementsJson', JSON.stringify(merged))
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('achievements:updated')
  }
  return merged
}

async function refreshAchievements(opts?: {
  skipPresenceSync?: boolean
  forceNetwork?: boolean
}): Promise<StoredAchievement[] | { error: string }> {
  if (!opts?.skipPresenceSync) {
    await syncActiveGameFromPresence()
  }
  const key = store.get('webApiKey').trim()
  const steamId = store.get('steamId').trim()
  const appId = store.get('appId').trim()
  if (!key || !steamId) {
    return { error: 'Set Steam Web API key and Steam ID in settings.' }
  }
  if (!appId) {
    return {
      error:
        'No Steam game detected. Launch a game with your Steam profile’s Game details set to Public, or turn off “Detect active game” and enter an App ID manually.'
    }
  }

  const force = Boolean(opts?.forceNetwork)
  const record = await persist.readTrophyGameRecord(steamId, appId)

  if (
    !force &&
    record?.lastMerged &&
    Array.isArray(record.lastMerged) &&
    record.lastMerged.length > 0 &&
    persist.msSince(record.mergedSavedAt) < persist.TTL_MS.fullSnapshot
  ) {
    const merged = record.lastMerged as StoredAchievement[]
    console.log('[psteam] trophies: using full snapshot cache (skip Steam HTTP)')
    return publishAchievements(merged)
  }

  try {
    const pStale =
      force || !record?.player?.length || persist.msSince(record.playerFetchedAt) >= persist.TTL_MS.player
    const sStale =
      force ||
      !record?.globalEntries?.length ||
      !record?.schemaEntries?.length ||
      persist.msSince(record.globalFetchedAt) >= persist.TTL_MS.static ||
      persist.msSince(record.schemaFetchedAt) >= persist.TTL_MS.static

    let player: Awaited<ReturnType<typeof fetchPlayerAchievements>>
    let globalMap: Map<string, number>
    let schemaMap: Map<string, { displayName: string; description: string; icon?: string; icongray?: string }>

    const nowIso = new Date().toISOString()

    if (!pStale && record?.player?.length) {
      player = record.player
    } else {
      player = await fetchPlayerAchievements(key, steamId, appId)
    }

    if (!sStale && record?.globalEntries?.length && record?.schemaEntries?.length) {
      const m = persist.mapsFromRecord(record)
      globalMap = m.globalMap
      schemaMap = m.schemaMap
    } else {
      const [g, sch] = await Promise.all([fetchGlobalPercents(appId), fetchSchemaDisplay(key, appId)])
      globalMap = g
      schemaMap = sch
    }

    const merged = mergeAchievements(player, globalMap, schemaMap)
    logSteamFetched(
      `merged trophies (${merged.length})`,
      merged.length > 80 ? [...merged.slice(0, 80), `… ${merged.length - 80} more`] : merged
    )

    await persist.writeTrophyGameRecord({
      steamId,
      appId,
      gameName: store.get('detectedGameName')?.trim() || undefined,
      player,
      playerFetchedAt: pStale ? nowIso : record?.playerFetchedAt ?? nowIso,
      globalEntries: [...globalMap.entries()],
      globalFetchedAt: sStale ? nowIso : record?.globalFetchedAt ?? nowIso,
      schemaEntries: Array.from(schemaMap.entries()) as persist.TrophyGameRecord['schemaEntries'],
      schemaFetchedAt: sStale ? nowIso : record?.schemaFetchedAt ?? nowIso,
      lastMerged: merged,
      mergedSavedAt: nowIso
    })

    return publishAchievements(merged)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const rec = await persist.readTrophyGameRecord(steamId, appId)
    const stale = rec?.lastMerged
    if (Array.isArray(stale) && stale.length > 0) {
      console.warn('[psteam] trophies: Steam request failed, using on-disk database snapshot:', msg)
      return publishAchievements(stale as StoredAchievement[])
    }
    return { error: msg }
  }
}

function mergedSavedAtMs(rec: persist.TrophyGameRecord | undefined): number {
  const t = Date.parse(rec?.mergedSavedAt ?? '')
  return Number.isFinite(t) ? t : 0
}

async function listDashboardGameStats(): Promise<DashboardGameStats[]> {
  const steamId = store.get('steamId').trim()
  if (!steamId) return []
  const fromDisk = await persist.listAllTrophyGameRecords({ steamId })
  const byKey = new Map<string, persist.TrophyGameRecord>()
  for (const r of fromDisk) {
    byKey.set(`${r.steamId.trim()}::${r.appId.trim()}`, r)
  }
  const appId = store.get('appId').trim()
  const achievements = store.get('achievements')
  if (appId && Array.isArray(achievements) && achievements.length > 0) {
    const cur: persist.TrophyGameRecord = {
      steamId,
      appId,
      gameName: store.get('detectedGameName')?.trim() || undefined,
      lastMerged: achievements,
      mergedSavedAt: new Date().toISOString()
    }
    const k = `${steamId}::${appId}`
    const prev = byKey.get(k)
    if (!prev || mergedSavedAtMs(cur) >= mergedSavedAtMs(prev)) {
      byKey.set(k, {
        ...prev,
        ...cur,
        gameName: cur.gameName || prev?.gameName,
        mergedSavedAt: cur.mergedSavedAt
      })
    }
  }
  return [...byKey.values()]
    .map((r) => trophyRecordToDashboardStats(r))
    .filter((s) => s.totalTrophies > 0)
    .sort((a, b) => b.progressPercent - a.progressPercent || a.gameName.localeCompare(b.gameName))
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 820,
    show: false,
    icon: getWindowIconPath(),
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

  /** Default `show` is true — that flashes an empty transparent window before paint on Windows. */
  const winOpts =
    process.platform === 'win32'
      ? {
          /** Frameless + fully transparent is flaky on some Windows/GPU stacks; solid chrome still reads as an overlay. */
          transparent: false as const,
          backgroundColor: '#0b0f1a'
        }
      : {
          transparent: true as const,
          backgroundColor: '#00000000' as const
        }

  overlayWindow = new BrowserWindow({
    width: saved?.width ?? w,
    height: saved?.height ?? h,
    x: saved?.x ?? defaultX,
    y: saved?.y ?? defaultY,
    frame: false,
    show: false,
    icon: getWindowIconPath(),
    ...winOpts,
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

  let shown = false
  const tryShowOverlay = (): void => {
    if (shown || !overlayWindow || overlayWindow.isDestroyed()) return
    shown = true
    bumpOverlayAboveGames(overlayWindow)
    overlayWindow.show()
    applyOverlayOpacity()
  }
  overlayWindow.once('ready-to-show', tryShowOverlay)
  overlayWindow.webContents.once('did-finish-load', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) bumpOverlayAboveGames(overlayWindow)
    setTimeout(tryShowOverlay, 50)
    if (store.get('overlayCompact')) {
      setTimeout(() => {
        if (overlayWindow && !overlayWindow.isDestroyed()) applyOverlayCompactLayout()
      }, 120)
    }
  })
  overlayWindow.webContents.once('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.error('[psteam] overlay failed to load', { code, desc, url })
  })
  /** If ready-to-show never fires, still surface the window (e.g. stuck navigation). */
  setTimeout(tryShowOverlay, 4000)

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
    const u = new URL(`${base}/`)
    u.searchParams.set('psteam', 'overlay')
    u.hash = 'overlay'
    void overlayWindow.loadURL(u.href)
  } else {
    void overlayWindow.loadFile(join(mainDir, '../renderer/index.html'), {
      hash: 'overlay',
      query: { psteam: 'overlay' }
    })
  }

  overlayWindow.on('moved', persistOverlayBounds)
  overlayWindow.on('resized', persistOverlayBounds)
  overlayWindow.on('focus', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) bumpOverlayAboveGames(overlayWindow)
  })
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
}

function persistOverlayBounds(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (store.get('overlayCompact')) return
  const b = overlayWindow.getBounds()
  store.set('overlayBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
}

/** Keep the panel above games where the OS allows it (not true exclusive fullscreen). */
function bumpOverlayAboveGames(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
    } catch {
      win.setAlwaysOnTop(true)
    }
  }
  win.moveTop()
}

function createTray(): void {
  const img = loadTrayImage()
  tray = new Tray(img)
  tray.setToolTip('PSteam trophies')
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show overlay',
      click: () => {
        if (!overlayWindow) {
          createOverlayWindow()
        } else {
          bumpOverlayAboveGames(overlayWindow)
          overlayWindow.show()
          applyOverlayOpacity()
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
      click: () => void refreshAchievements({ forceNetwork: true })
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
}

function startSteamPolling(): void {
  if (steamPollTimer) clearInterval(steamPollTimer)
  if (gamePresenceTimer) clearInterval(gamePresenceTimer)
  steamPollTimer = setInterval(() => {
    void refreshAchievements()
  }, 60_000)
  gamePresenceTimer = setInterval(() => {
    void (async () => {
      const changed = await syncActiveGameFromPresence()
      if (changed) await refreshAchievements({ skipPresenceSync: true })
    })()
  }, 20_000)
  void refreshAchievements()
}

function stopSteamPolling(): void {
  if (steamPollTimer) {
    clearInterval(steamPollTimer)
    steamPollTimer = null
  }
  if (gamePresenceTimer) {
    clearInterval(gamePresenceTimer)
    gamePresenceTimer = null
  }
}

function ensureOverlayForSteam(running: boolean): void {
  if (!store.get('startWithSteamWatch')) return
  if (running && !overlayWindow) {
    createOverlayWindow()
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
    if (!overlayWindow) {
      createOverlayWindow()
    } else {
      bumpOverlayAboveGames(overlayWindow)
      overlayWindow.show()
      applyOverlayOpacity()
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
  const sid = store.get('steamId').trim()
  const key = store.get('webApiKey').trim()
  const app = store.get('appId').trim()
  const auto = store.get('autoDetectGame')
  return Boolean(sid && key && (app || auto))
}

app.whenReady().then(async () => {
  await persist.setMongoConnectionOptions(store.get('mongoUri'), store.get('mongoDbName'))
  await hydrateLastGameFromCacheIfNeeded()
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
  void persist.closeMongoClient()
})

ipcMain.handle('store:get', (_e, key: keyof StoreSchema) => store.get(key))
ipcMain.handle('store:set', (_e, key: keyof StoreSchema, value: StoreSchema[keyof StoreSchema]) => {
  store.set(key, value as never)
  if (key === 'startWithSteamWatch') {
    applySteamLaunchMode()
  }
  if (key === 'overlayOpacity') {
    applyOverlayOpacity()
  }
  if (key === 'overlayCompact') {
    applyOverlayCompactLayout()
  }
  if (key === 'appId' && typeof value === 'string' && value.trim()) {
    const sid = store.get('steamId').trim()
    if (sid) {
      void persist.writeLastGameCache({
        steamId: sid,
        appId: value.trim(),
        gameName: store.get('detectedGameName') || '',
        updatedAt: Date.now()
      })
    }
  }
  if (key === 'mongoUri' || key === 'mongoDbName') {
    void persist.setMongoConnectionOptions(store.get('mongoUri'), store.get('mongoDbName'))
  }
  if (key === 'autoDetectGame') {
    void refreshAchievements()
  }
})
ipcMain.handle('achievements:refresh', (_e, payload?: { forceNetwork?: boolean }) =>
  refreshAchievements({ forceNetwork: payload?.forceNetwork === true })
)
ipcMain.handle('dashboard:list-games', () => listDashboardGameStats())
ipcMain.handle('overlay:set-compact', (_e, compact: boolean) => {
  store.set('overlayCompact', Boolean(compact))
  applyOverlayCompactLayout()
  return Boolean(store.get('overlayCompact'))
})
ipcMain.handle('overlay:close', () => {
  overlayWindow?.hide()
})
ipcMain.handle('overlay:bump-z-order', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  bumpOverlayAboveGames(overlayWindow)
  overlayWindow.focus()
})
ipcMain.handle('app:open-settings', () => {
  mainWindow?.show()
  mainWindow?.focus()
})
