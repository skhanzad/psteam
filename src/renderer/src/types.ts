export type TrophyTier = 'gold' | 'silver' | 'bronze'

export type TrophyUnlockPayload = {
  displayName: string
  tier: TrophyTier
  description: string
  /** Steam schema icon (HTTPS) */
  iconUrl?: string
}

export type StoredAchievement = {
  apiname: string
  displayName: string
  description: string
  achieved: boolean
  unlocktime: number
  globalPercent: number | null
  tier: TrophyTier
  icon?: string
  iconGray?: string
}

export type PsteamApi = {
  /** True only in the floating trophy window (not the settings window). */
  isOverlayWindow: boolean
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  achievementsRefresh: () => Promise<StoredAchievement[] | { error: string }>
  overlayClose: () => Promise<void>
  openSettings: () => Promise<void>
  /** Shrink overlay to a thin on-screen strip (not taskbar minimize). */
  overlaySetCompact: (compact: boolean) => Promise<boolean>
  onOverlayCompact: (cb: (compact: boolean) => void) => () => void
  onTrophyUnlock: (cb: (p: TrophyUnlockPayload) => void) => () => void
  onAchievementsUpdated: (cb: () => void) => () => void
}

declare global {
  interface Window {
    psteam: PsteamApi
  }
}

export {}
