import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MongoClient, type Db, type Document, type Filter } from 'mongodb'

/** Local JSON fallback under userData when MongoDB is not configured or unreachable. */
const dataRoot = (): string => join(app.getPath('userData'), 'psteam-data')

export const TTL_MS = {
  fullSnapshot: 5 * 60 * 1000,
  player: 2 * 60 * 1000,
  static: 7 * 24 * 60 * 60 * 1000
} as const

export type LastGameCacheEntry = {
  steamId: string
  appId: string
  gameName: string
  updatedAt: number
}

export type PlayerAchievementRow = {
  apiname: string
  achieved: number | boolean | string
  unlocktime: number
  name?: string
  description?: string
}

export type SchemaMeta = {
  displayName: string
  description: string
  icon?: string
  icongray?: string
}

export type TrophyGameRecord = {
  steamId: string
  appId: string
  /** Friendly title when known (e.g. from Steam presence). */
  gameName?: string
  player?: PlayerAchievementRow[]
  playerFetchedAt?: string
  globalEntries?: [string, number][]
  globalFetchedAt?: string
  schemaEntries?: [string, SchemaMeta][]
  schemaFetchedAt?: string
  lastMerged?: unknown[]
  mergedSavedAt?: string
}

const LAST_GAME_ID = 'singleton' as const

let mongoUri = ''
let mongoDbName = 'psteam'
let mongoClient: MongoClient | null = null
let mongoConnectPromise: Promise<Db | null> | null = null

export async function closeMongoClient(): Promise<void> {
  mongoConnectPromise = null
  if (mongoClient) {
    try {
      await mongoClient.close()
    } catch {
      /* ignore */
    }
    mongoClient = null
  }
}

export async function setMongoConnectionOptions(uri: string, database: string): Promise<void> {
  const u = uri.trim()
  const d = (database || 'psteam').trim() || 'psteam'
  if (u === mongoUri && d === mongoDbName) return
  await closeMongoClient()
  mongoUri = u
  mongoDbName = d
}

async function getMongoDb(): Promise<Db | null> {
  if (!mongoUri) return null
  if (mongoClient) return mongoClient.db(mongoDbName)
  if (!mongoConnectPromise) {
    mongoConnectPromise = (async (): Promise<Db | null> => {
      try {
        const c = new MongoClient(mongoUri)
        await c.connect()
        mongoClient = c
        return c.db(mongoDbName)
      } catch (e) {
        console.warn('[psteam] MongoDB connect failed; using file persistence.', e)
        return null
      } finally {
        mongoConnectPromise = null
      }
    })()
  }
  return mongoConnectPromise
}

function lastGameCachePath(): string {
  return join(dataRoot(), 'last-game-cache.json')
}

function gamesDir(): string {
  return join(dataRoot(), 'trophy-database', 'games')
}

function gameRecordPath(steamId: string, appId: string): string {
  const safeSid = steamId.replace(/\D/g, '')
  const safeApp = appId.replace(/\D/g, '')
  return join(gamesDir(), `${safeSid}_${safeApp}.json`)
}

function ensureDirs(): void {
  mkdirSync(gamesDir(), { recursive: true })
}

function readLastGameCacheFromFile(): LastGameCacheEntry | null {
  try {
    const p = lastGameCachePath()
    if (!existsSync(p)) return null
    const o = JSON.parse(readFileSync(p, 'utf8')) as LastGameCacheEntry
    if (!o || typeof o.steamId !== 'string' || typeof o.appId !== 'string') return null
    return o
  } catch {
    return null
  }
}

function writeLastGameCacheToFile(entry: LastGameCacheEntry): void {
  try {
    mkdirSync(dataRoot(), { recursive: true })
    writeFileSync(lastGameCachePath(), JSON.stringify(entry, null, 0), 'utf8')
  } catch (e) {
    console.warn('[psteam] last-game file cache write failed', e)
  }
}

function readTrophyGameRecordFromFile(steamId: string, appId: string): TrophyGameRecord | null {
  try {
    const p = gameRecordPath(steamId, appId)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as TrophyGameRecord
  } catch {
    return null
  }
}

function writeTrophyGameRecordToFile(rec: TrophyGameRecord): void {
  try {
    ensureDirs()
    writeFileSync(gameRecordPath(rec.steamId, rec.appId), JSON.stringify(rec, null, 0), 'utf8')
  } catch (e) {
    console.warn('[psteam] trophy file database write failed', e)
  }
}

export function msSince(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY
  return Date.now() - t
}

export async function readLastGameCache(): Promise<LastGameCacheEntry | null> {
  const db = await getMongoDb()
  if (db) {
    try {
      const doc = await db.collection('last_game_cache').findOne<LastGameCacheEntry & { _id: string }>({
        _id: LAST_GAME_ID
      } as unknown as Filter<Document>)
      if (doc && typeof doc.steamId === 'string' && typeof doc.appId === 'string') {
        return {
          steamId: doc.steamId,
          appId: doc.appId,
          gameName: typeof doc.gameName === 'string' ? doc.gameName : '',
          updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0
        }
      }
    } catch (e) {
      console.warn('[psteam] MongoDB read last_game_cache failed; trying file.', e)
    }
  }
  return readLastGameCacheFromFile()
}

export async function writeLastGameCache(entry: LastGameCacheEntry): Promise<void> {
  writeLastGameCacheToFile(entry)
  const db = await getMongoDb()
  if (!db) return
  try {
    await db.collection('last_game_cache').updateOne(
      { _id: LAST_GAME_ID } as unknown as Filter<Document>,
      { $set: { _id: LAST_GAME_ID, ...entry } },
      { upsert: true }
    )
  } catch (e) {
    console.warn('[psteam] MongoDB write last_game_cache failed (file copy kept).', e)
  }
}

function gameDocId(steamId: string, appId: string): string {
  return `${steamId.replace(/\D/g, '')}_${appId.replace(/\D/g, '')}`
}

export async function readTrophyGameRecord(steamId: string, appId: string): Promise<TrophyGameRecord | null> {
  const db = await getMongoDb()
  if (db) {
    try {
      const doc = await db.collection('trophy_games').findOne<Record<string, unknown>>({
        _id: gameDocId(steamId, appId)
      } as unknown as Filter<Document>)
      if (doc) {
        const { _id: _drop, ...rest } = doc
        return rest as TrophyGameRecord
      }
    } catch (e) {
      console.warn('[psteam] MongoDB read trophy_games failed; trying file.', e)
    }
  }
  return readTrophyGameRecordFromFile(steamId, appId)
}

export async function writeTrophyGameRecord(rec: TrophyGameRecord): Promise<void> {
  writeTrophyGameRecordToFile(rec)
  const db = await getMongoDb()
  if (!db) return
  try {
    const _id = gameDocId(rec.steamId, rec.appId)
    await db
      .collection('trophy_games')
      .updateOne({ _id } as unknown as Filter<Document>, { $set: { ...rec, _id } }, { upsert: true })
  } catch (e) {
    console.warn('[psteam] MongoDB write trophy_games failed (file copy kept).', e)
  }
}

export function mapsFromRecord(r: TrophyGameRecord): {
  globalMap: Map<string, number>
  schemaMap: Map<string, SchemaMeta>
} {
  return {
    globalMap: new Map<string, number>(r.globalEntries ?? []),
    schemaMap: new Map<string, SchemaMeta>(r.schemaEntries ?? [])
  }
}

function recordRecencyMs(r: TrophyGameRecord): number {
  const t = Date.parse(r.mergedSavedAt ?? '')
  return Number.isFinite(t) ? t : 0
}

function recordKey(r: Pick<TrophyGameRecord, 'steamId' | 'appId'>): string {
  return `${r.steamId.trim()}::${r.appId.trim()}`
}

/** All cached per-game trophy snapshots for an account (files + Mongo, de-duplicated by recency). */
export async function listAllTrophyGameRecords(options?: { steamId?: string }): Promise<TrophyGameRecord[]> {
  const sidFilter = options?.steamId?.trim()
  const byKey = new Map<string, TrophyGameRecord>()

  const merge = (rec: TrophyGameRecord): void => {
    if (!rec.steamId?.trim() || !rec.appId?.trim()) return
    if (sidFilter && rec.steamId.trim() !== sidFilter) return
    const key = recordKey(rec)
    const prev = byKey.get(key)
    if (!prev || recordRecencyMs(rec) >= recordRecencyMs(prev)) {
      byKey.set(key, rec)
    }
  }

  if (existsSync(gamesDir())) {
    for (const name of readdirSync(gamesDir())) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = JSON.parse(readFileSync(join(gamesDir(), name), 'utf8')) as TrophyGameRecord
        merge(raw)
      } catch {
        /* skip corrupt file */
      }
    }
  }

  const db = await getMongoDb()
  if (db) {
    try {
      const docs = await db
        .collection('trophy_games')
        .find({} as unknown as Filter<Document>)
        .toArray()
      for (const doc of docs) {
        const o = { ...doc } as unknown as Record<string, unknown>
        delete o._id
        merge(o as TrophyGameRecord)
      }
    } catch (e) {
      console.warn('[psteam] MongoDB list trophy_games failed', e)
    }
  }

  return [...byKey.values()].sort((a, b) => recordRecencyMs(b) - recordRecencyMs(a))
}
