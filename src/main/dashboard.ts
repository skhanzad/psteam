import type { TrophyGameRecord } from './persistence'

export type DashboardTierCounts = {
  gold: number
  silver: number
  bronze: number
}

export type DashboardGameStats = {
  steamId: string
  appId: string
  gameName: string
  totalTrophies: number
  unlockedTrophies: number
  progressPercent: number
  tierTotal: DashboardTierCounts
  tierUnlocked: DashboardTierCounts
  platinumEarned: boolean
  mergedSavedAt?: string
}

type GsbTier = 'gold' | 'silver' | 'bronze'

function parseGsbTier(raw: unknown): GsbTier {
  const t = String(raw)
  if (t === 'gold' || t === 'silver' || t === 'bronze') return t
  return 'bronze'
}

export function trophyRecordToDashboardStats(rec: TrophyGameRecord): DashboardGameStats {
  const raw = rec.lastMerged
  const tierTotal: DashboardTierCounts = { gold: 0, silver: 0, bronze: 0 }
  const tierUnlocked: DashboardTierCounts = { gold: 0, silver: 0, bronze: 0 }

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      steamId: rec.steamId,
      appId: rec.appId,
      gameName: (rec.gameName && rec.gameName.trim()) || `App ${rec.appId}`,
      totalTrophies: 0,
      unlockedTrophies: 0,
      progressPercent: 0,
      tierTotal,
      tierUnlocked,
      platinumEarned: false,
      mergedSavedAt: rec.mergedSavedAt
    }
  }

  let unlocked = 0
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    if (typeof o.apiname !== 'string') continue
    const tier = parseGsbTier(o.tier)
    tierTotal[tier]++
    const ach = Boolean(o.achieved)
    if (ach) {
      unlocked++
      tierUnlocked[tier]++
    }
  }

  const total = tierTotal.gold + tierTotal.silver + tierTotal.bronze
  const platinumEarned = total > 0 && unlocked === total

  return {
    steamId: rec.steamId,
    appId: rec.appId,
    gameName: (rec.gameName && rec.gameName.trim()) || `App ${rec.appId}`,
    totalTrophies: total,
    unlockedTrophies: unlocked,
    progressPercent: total ? Math.round((100 * unlocked) / total) : 0,
    tierTotal,
    tierUnlocked,
    platinumEarned,
    mergedSavedAt: rec.mergedSavedAt
  }
}
