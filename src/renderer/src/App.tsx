import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoredAchievement, TrophyTier, TrophyUnlockPayload } from './types'

function isOverlay(): boolean {
  // URL first: avoids a throw if `window.psteam` is missing, and survives when
  // `--psteam-overlay` is not present on the preload argv (hash/query still set from main).
  const hash = window.location.hash.replace(/^#/, '')
  if (hash === 'overlay') return true
  if (new URLSearchParams(window.location.search).get('psteam') === 'overlay') return true
  return Boolean(window.psteam?.isOverlayWindow)
}

function tierLabel(t: TrophyTier): string {
  if (t === 'gold') return 'G'
  if (t === 'silver') return 'S'
  return 'B'
}

function countsByTier(list: StoredAchievement[]): { gold: number; silver: number; bronze: number } {
  const unlocked = list.filter((a) => a.achieved)
  return {
    gold: unlocked.filter((a) => a.tier === 'gold').length,
    silver: unlocked.filter((a) => a.tier === 'silver').length,
    bronze: unlocked.filter((a) => a.tier === 'bronze').length
  }
}

function formatGlobalPercent(p: number | string | null | undefined): string {
  if (p == null || p === '') return 'Global % unknown'
  const n = typeof p === 'number' ? p : Number.parseFloat(String(p).replace(',', '.'))
  if (!Number.isFinite(n)) return 'Global % unknown'
  return `${n.toFixed(1)}% of players`
}

function trophyImageSrc(a: StoredAchievement): string | undefined {
  if (a.achieved) return a.icon || a.iconGray
  return a.iconGray || a.icon
}

function normalizeAchievementRow(raw: unknown): StoredAchievement | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.apiname !== 'string') return null
  const gpRaw = o.globalPercent
  let globalPercent: number | null = null
  if (typeof gpRaw === 'number' && Number.isFinite(gpRaw)) globalPercent = gpRaw
  else if (typeof gpRaw === 'string') {
    const x = Number.parseFloat(gpRaw.replace(',', '.'))
    globalPercent = Number.isFinite(x) ? x : null
  }
  const tier = (['gold', 'silver', 'bronze'].includes(String(o.tier)) ? o.tier : 'bronze') as TrophyTier
  return {
    apiname: o.apiname,
    displayName: typeof o.displayName === 'string' ? o.displayName : String(o.apiname),
    description: typeof o.description === 'string' ? o.description : '',
    achieved: Boolean(o.achieved),
    unlocktime: typeof o.unlocktime === 'number' && Number.isFinite(o.unlocktime) ? o.unlocktime : 0,
    globalPercent,
    tier,
    icon: typeof o.icon === 'string' ? o.icon : undefined,
    iconGray: typeof o.iconGray === 'string' ? o.iconGray : undefined
  }
}

function normalizeAchievementsFromStore(raw: unknown): StoredAchievement[] {
  if (Array.isArray(raw)) {
    return raw.map(normalizeAchievementRow).filter((x): x is StoredAchievement => x != null)
  }
  if (raw && typeof raw === 'object') {
    const vals = Object.values(raw as Record<string, unknown>)
    if (
      vals.length > 0 &&
      typeof vals[0] === 'object' &&
      vals[0] !== null &&
      'apiname' in (vals[0] as object)
    ) {
      return vals.map(normalizeAchievementRow).filter((x): x is StoredAchievement => x != null)
    }
  }
  return []
}

function OverlayView(): JSX.Element {
  const [list, setList] = useState<StoredAchievement[]>([])
  const [toast, setToast] = useState<TrophyUnlockPayload | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [compact, setCompact] = useState(false)

  const load = useCallback(async () => {
    const raw = await window.psteam.storeGet('achievements')
    setList(normalizeAchievementsFromStore(raw))
  }, [])

  const tryRefresh = useCallback(async () => {
    const res = await window.psteam.achievementsRefresh()
    if (res && 'error' in res) setLoadErr(res.error)
    else setLoadErr(null)
    void load()
  }, [load])

  useEffect(() => {
    document.documentElement.classList.add('psteam-overlay')
    document.body.classList.add('psteam-overlay')
    return () => {
      document.documentElement.classList.remove('psteam-overlay')
      document.body.classList.remove('psteam-overlay')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const c = await window.psteam.storeGet('overlayCompact')
      setCompact(c === true)
    })()
    const offCompact = window.psteam.onOverlayCompact((v) => setCompact(v))
    return () => {
      offCompact()
    }
  }, [])

  useEffect(() => {
    void load()
    void tryRefresh()
    const off = window.psteam.onAchievementsUpdated(() => void load())
    const offUnlock = window.psteam.onTrophyUnlock((p) => {
      setToast(p)
      window.setTimeout(() => setToast(null), 5200)
      void load()
    })
    return () => {
      off()
      offUnlock()
    }
  }, [load, tryRefresh])

  const { gold, silver, bronze } = useMemo(() => countsByTier(list), [list])

  const sorted = useMemo(() => {
    const tierRank: Record<TrophyTier, number> = { gold: 0, silver: 1, bronze: 2 }
    return [...list].sort((a, b) => {
      if (a.achieved !== b.achieved) return a.achieved ? -1 : 1
      if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier]
      return a.displayName.localeCompare(b.displayName)
    })
  }, [list])

  return (
    <div
      className={`overlay-root${compact ? ' overlay-root--compact' : ''}`}
      onPointerDownCapture={() => {
        void window.psteam.overlayBumpZOrder()
      }}
    >
      <div className="panel">
        <header className="overlay-header">
          <div className="title-block">
            <h1>Trophies</h1>
            {!compact ? (
              <p>Steam achievements · PS-style tiers</p>
            ) : (
              <p className="compact-counts">
                Unlocked: {list.filter((x) => x.achieved).length}/{list.length} · G {gold} · S {silver} · B {bronze}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="icon-btn" title="Refresh" onClick={() => void tryRefresh()}>
              ↻
            </button>
            {!compact ? (
              <button
                type="button"
                className="icon-btn"
                title="Minimize to strip (stays visible on screen)"
                onClick={() => void window.psteam.overlaySetCompact(true)}
              >
                −
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                title="Expand full trophy list"
                onClick={() => void window.psteam.overlaySetCompact(false)}
              >
                ⤢
              </button>
            )}
            <button type="button" className="icon-btn" title="Settings" onClick={() => void window.psteam.openSettings()}>
              ⚙
            </button>
            <button type="button" className="icon-btn" title="Hide overlay" onClick={() => void window.psteam.overlayClose()}>
              ×
            </button>
          </div>
        </header>

        <div className="overlay-expanded-only">
          <div className="trophy-meter">
          <div className="meter gold">
            <div className="label">Gold</div>
            <div className="count">{gold}</div>
          </div>
          <div className="meter silver">
            <div className="label">Silver</div>
            <div className="count">{silver}</div>
          </div>
          <div className="meter bronze">
            <div className="label">Bronze</div>
            <div className="count">{bronze}</div>
          </div>
        </div>

        <div className="tier-legend">
          Tiers use global rarity: gold ≤5% of players, silver ≤25%, bronze above that (or unknown).
        </div>

        {loadErr ? <div className="err">{loadErr}</div> : null}

        <div className="list">
          {sorted.length === 0 && !loadErr ? (
            <p className="pct" style={{ padding: '12px 8px' }}>
              No trophy data yet. Open settings (⚙), confirm your Web API key, 64-bit Steam ID, and the game&apos;s App
              ID, then Save &amp; refresh. On Steam, set Profile → Edit Profile → Privacy Settings → Game details to{' '}
              <strong>Public</strong> so the Web API can read achievements.
            </p>
          ) : null}
          {sorted.map((a) => {
            const img = trophyImageSrc(a)
            return (
              <div key={a.apiname} className={`row ${a.achieved ? '' : 'locked'}`}>
                {img ? (
                  <div className={`trophy-thumb-wrap tier-ring-${a.tier}`}>
                    <img className="trophy-thumb" src={img} alt="" draggable={false} />
                  </div>
                ) : (
                  <div className={`badge ${a.tier}`}>{tierLabel(a.tier)}</div>
                )}
                <div className="row-body">
                  <h2>{a.displayName}</h2>
                  {a.description ? <p>{a.description}</p> : null}
                  <div className="pct">
                    {formatGlobalPercent(a.globalPercent)}
                    {!a.achieved ? ' · locked' : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        </div>
      </div>

      {toast && !compact ? (
        <div className="toast-wrap">
          <div className="toast">
            <div className="toast-top">
              {toast.iconUrl ? (
                <img className="toast-thumb" src={toast.iconUrl} alt="" draggable={false} />
              ) : (
                <div className={`badge ${toast.tier}`}>{tierLabel(toast.tier)}</div>
              )}
              <div>
                <div className="trophy-word">Trophy unlocked</div>
                <h3>{toast.displayName}</h3>
              </div>
            </div>
            {toast.description ? <p className="pct" style={{ marginTop: 8 }}>{toast.description}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SettingsView(): JSX.Element {
  const [steamId, setSteamId] = useState('')
  const [webApiKey, setWebApiKey] = useState('')
  const [appId, setAppId] = useState('')
  const [startWithSteamWatch, setStartWithSteamWatch] = useState(true)
  const [autoDetectGame, setAutoDetectGame] = useState(true)
  const [detectedGameName, setDetectedGameName] = useState('')
  const [overlayOpacity, setOverlayOpacity] = useState(1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setSteamId(String(await window.psteam.storeGet('steamId')))
      setWebApiKey(String(await window.psteam.storeGet('webApiKey')))
      setAppId(String(await window.psteam.storeGet('appId')))
      setStartWithSteamWatch(Boolean(await window.psteam.storeGet('startWithSteamWatch')))
      const rawAuto = await window.psteam.storeGet('autoDetectGame')
      setAutoDetectGame(rawAuto !== false)
      setDetectedGameName(String(await window.psteam.storeGet('detectedGameName') ?? ''))
      const rawOp = await window.psteam.storeGet('overlayOpacity')
      const n = typeof rawOp === 'number' ? rawOp : Number.parseFloat(String(rawOp))
      setOverlayOpacity(Number.isFinite(n) ? Math.min(1, Math.max(0.2, n)) : 1)
    })()
  }, [])

  const save = async (): Promise<void> => {
    setErr(null)
    await window.psteam.storeSet('steamId', steamId.trim())
    await window.psteam.storeSet('webApiKey', webApiKey.trim())
    await window.psteam.storeSet('appId', appId.trim())
    await window.psteam.storeSet('startWithSteamWatch', startWithSteamWatch)
    await window.psteam.storeSet('autoDetectGame', autoDetectGame)
    await window.psteam.storeSet('overlayOpacity', overlayOpacity)
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await save()
      const res = await window.psteam.achievementsRefresh()
      if (res && 'error' in res) setErr(res.error)
      setAppId(String(await window.psteam.storeGet('appId')))
      setDetectedGameName(String(await window.psteam.storeGet('detectedGameName') ?? ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-wrap">
      <div className="settings panel">
        <h1>PSteam</h1>
        <p className="sub">Trophy-style overlay for Steam achievements.</p>

        <div className="field">
          <label htmlFor="key">Steam Web API key</label>
          <input
            id="key"
            type="password"
            autoComplete="off"
            value={webApiKey}
            onChange={(e) => setWebApiKey(e.target.value)}
            placeholder="From steamcommunity.com/dev/apikey"
          />
        </div>

        <div className="field">
          <label htmlFor="sid">Steam ID (64-bit)</label>
          <input
            id="sid"
            value={steamId}
            onChange={(e) => setSteamId(e.target.value)}
            placeholder="76561198…"
          />
        </div>

        <div className="field">
          <label htmlFor="app">Game App ID</label>
          <input id="app" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 1245620" />
          {detectedGameName ? (
            <p className="field-hint">Last detected in Steam: {detectedGameName}</p>
          ) : null}
        </div>

        <label className="row-check">
          <input
            type="checkbox"
            checked={autoDetectGame}
            onChange={(e) => {
              const v = e.target.checked
              setAutoDetectGame(v)
              void window.psteam.storeSet('autoDetectGame', v)
            }}
          />
          Detect active Steam game automatically (uses profile “now playing”; Game details must be Public)
        </label>

        <div className="field">
          <label htmlFor="opacity">
            Overlay opacity <span className="opacity-value">{Math.round(overlayOpacity * 100)}%</span>
          </label>
          <input
            id="opacity"
            type="range"
            min={20}
            max={100}
            step={1}
            value={Math.round(overlayOpacity * 100)}
            onChange={(e) => {
              const pct = Number(e.target.value)
              const v = Math.min(1, Math.max(0.2, pct / 100))
              setOverlayOpacity(v)
              void window.psteam.storeSet('overlayOpacity', v)
            }}
          />
          <p className="field-hint">Applies to the floating trophy window (20–100%).</p>
        </div>

        <label className="row-check">
          <input
            type="checkbox"
            checked={startWithSteamWatch}
            onChange={(e) => setStartWithSteamWatch(e.target.checked)}
          />
          Open overlay when Steam starts (recommended)
        </label>

        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Saving…' : 'Save & refresh'}
          </button>
        </div>

        {err ? <div className="err">{err}</div> : null}

        <p className="hint">
          Add PSteam to OS startup (Windows: shell:startup, Linux: autostart) so it can detect when Steam launches. The
          Web API key is stored only on your machine. With auto-detect on, the App ID field updates while you play; you
          can still override it manually when auto-detect is off.
        </p>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return isOverlay() ? <OverlayView /> : <SettingsView />
}
