import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StoredAchievement, TrophyTier, TrophyUnlockPayload } from './types'

function isOverlay(): boolean {
  if (window.psteam.isOverlayWindow) return true
  if (window.location.hash.replace(/^#/, '') === 'overlay') return true
  return new URLSearchParams(window.location.search).get('psteam') === 'overlay'
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

function OverlayView(): JSX.Element {
  const [list, setList] = useState<StoredAchievement[]>([])
  const [toast, setToast] = useState<TrophyUnlockPayload | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const raw = (await window.psteam.storeGet('achievements')) as StoredAchievement[]
    setList(Array.isArray(raw) ? raw : [])
  }, [])

  const tryRefresh = useCallback(async () => {
    const res = await window.psteam.achievementsRefresh()
    if (res && 'error' in res) setLoadErr(res.error)
    else setLoadErr(null)
    void load()
  }, [load])

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
    <div className="overlay-root">
      <div className="panel">
        <header className="overlay-header">
          <div className="title-block">
            <h1>Trophies</h1>
            <p>Steam achievements · PS-style tiers</p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="icon-btn" title="Refresh" onClick={() => void tryRefresh()}>
              ↻
            </button>
            <button type="button" className="icon-btn" title="Settings" onClick={() => void window.psteam.openSettings()}>
              ⚙
            </button>
            <button type="button" className="icon-btn" title="Hide overlay" onClick={() => void window.psteam.overlayClose()}>
              ×
            </button>
          </div>
        </header>

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
              No trophy data yet. Open settings (⚙), set your Web API key, Steam ID, and this game&apos;s App ID, then
              save and refresh.
            </p>
          ) : null}
          {sorted.map((a) => (
            <div key={a.apiname} className={`row ${a.achieved ? '' : 'locked'}`}>
              <div className={`badge ${a.tier}`}>{tierLabel(a.tier)}</div>
              <div className="row-body">
                <h2>{a.displayName}</h2>
                {a.description ? <p>{a.description}</p> : null}
                <div className="pct">
                  {a.globalPercent != null ? `${a.globalPercent.toFixed(1)}% of players` : 'Global % unknown'}
                  {!a.achieved ? ' · locked' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {toast ? (
        <div className="toast-wrap">
          <div className="toast">
            <div className="toast-top">
              <div className={`badge ${toast.tier}`}>{tierLabel(toast.tier)}</div>
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
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setSteamId(String(await window.psteam.storeGet('steamId')))
      setWebApiKey(String(await window.psteam.storeGet('webApiKey')))
      setAppId(String(await window.psteam.storeGet('appId')))
      setStartWithSteamWatch(Boolean(await window.psteam.storeGet('startWithSteamWatch')))
    })()
  }, [])

  const save = async (): Promise<void> => {
    setErr(null)
    await window.psteam.storeSet('steamId', steamId.trim())
    await window.psteam.storeSet('webApiKey', webApiKey.trim())
    await window.psteam.storeSet('appId', appId.trim())
    await window.psteam.storeSet('startWithSteamWatch', startWithSteamWatch)
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await save()
      const res = await window.psteam.achievementsRefresh()
      if (res && 'error' in res) setErr(res.error)
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
          Web API key is stored only on your machine. Use the numeric App ID from the store URL.
        </p>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  return isOverlay() ? <OverlayView /> : <SettingsView />
}
