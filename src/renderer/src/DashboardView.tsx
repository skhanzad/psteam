import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DashboardGameStats } from './types'
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid
} from 'recharts'
import './dashboard.css'

const COL = {
  gold: '#e8c547',
  silver: '#c8d4e8',
  bronze: '#c67f4a',
  unlocked: '#5cdb9a',
  locked: '#3d4a6a'
}

type DashboardViewProps = {
  onBack: () => void
}

export function DashboardView({ onBack }: DashboardViewProps): JSX.Element {
  const [games, setGames] = useState<DashboardGameStats[]>([])
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const g = await window.psteam.dashboardListGames()
      setGames(Array.isArray(g) ? g : [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const agg = useMemo(() => {
    let unlocked = 0
    let total = 0
    const tierT = { gold: 0, silver: 0, bronze: 0 }
    const tierU = { gold: 0, silver: 0, bronze: 0 }
    let platinumGames = 0
    for (const g of games) {
      unlocked += g.unlockedTrophies
      total += g.totalTrophies
      tierT.gold += g.tierTotal.gold
      tierT.silver += g.tierTotal.silver
      tierT.bronze += g.tierTotal.bronze
      tierU.gold += g.tierUnlocked.gold
      tierU.silver += g.tierUnlocked.silver
      tierU.bronze += g.tierUnlocked.bronze
      if (g.platinumEarned) platinumGames++
    }
    return {
      unlocked,
      total,
      tierT,
      tierU,
      platinumGames,
      gamesCount: games.length,
      overallPct: total ? Math.round((100 * unlocked) / total) : 0
    }
  }, [games])

  const tierTotalPie = useMemo(
    () =>
      [
        { name: 'Gold', value: agg.tierT.gold, color: COL.gold },
        { name: 'Silver', value: agg.tierT.silver, color: COL.silver },
        { name: 'Bronze', value: agg.tierT.bronze, color: COL.bronze }
      ].filter((d) => d.value > 0),
    [agg]
  )

  const overallProgressPie = useMemo(() => {
    const locked = Math.max(0, agg.total - agg.unlocked)
    return [
      { name: 'Unlocked', value: agg.unlocked, color: COL.unlocked },
      { name: 'Locked', value: locked, color: COL.locked }
    ].filter((d) => d.value > 0)
  }, [agg])

  const tierStackedBar = useMemo(
    () => [
      {
        name: 'Gold',
        unlocked: agg.tierU.gold,
        locked: Math.max(0, agg.tierT.gold - agg.tierU.gold)
      },
      {
        name: 'Silver',
        unlocked: agg.tierU.silver,
        locked: Math.max(0, agg.tierT.silver - agg.tierU.silver)
      },
      {
        name: 'Bronze',
        unlocked: agg.tierU.bronze,
        locked: Math.max(0, agg.tierT.bronze - agg.tierU.bronze)
      }
    ],
    [agg]
  )

  return (
    <div className="dashboard-root">
      <header className="dashboard-header">
        <button type="button" className="btn" onClick={onBack}>
          ← Settings
        </button>
        <h1>Trophy dashboard</h1>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {err ? <div className="dashboard-err">{err}</div> : null}

      {games.length === 0 && !err ? (
        <div className="dashboard-empty">
          No cached games yet for this Steam account. Play a game with PSteam running (or Save &amp; refresh in settings)
          so trophy snapshots are stored — then open this dashboard again.
        </div>
      ) : null}

      {games.length > 0 ? (
        <>
          <section className="dashboard-summary">
            <div className="dashboard-stat-card">
              <div className="label">Games tracked</div>
              <div className="value">{agg.gamesCount}</div>
              <div className="sub">From local files + MongoDB</div>
            </div>
            <div className="dashboard-stat-card">
              <div className="label">Trophies unlocked</div>
              <div className="value">
                {agg.unlocked}
                <span style={{ fontSize: 16, color: 'var(--muted)', fontWeight: 600 }}> / {agg.total}</span>
              </div>
              <div className="sub">Across all listed games</div>
            </div>
            <div className="dashboard-stat-card">
              <div className="label">Overall progress</div>
              <div className="value">{agg.overallPct}%</div>
              <div className="sub">Weighted by trophy count</div>
            </div>
            <div className="dashboard-stat-card">
              <div className="label">Platinum (100%)</div>
              <div className="value">{agg.platinumGames}</div>
              <div className="sub">Games with every trophy</div>
            </div>
          </section>

          <div className="dashboard-grid">
            <div className="dashboard-panel">
              <h2>All trophies by tier (totals)</h2>
              <div className="chart-wrap">
                {tierTotalPie.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={tierTotalPie}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={88}
                        paddingAngle={2}
                      >
                        {tierTotalPie.map((e) => (
                          <Cell key={e.name} fill={e.color} stroke="rgba(0,0,0,0.35)" />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => [`${v} trophies`, 'Count']} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : null}
              </div>
            </div>

            <div className="dashboard-panel">
              <h2>Overall unlock vs locked</h2>
              <div className="chart-wrap">
                {overallProgressPie.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={overallProgressPie}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={48}
                        outerRadius={88}
                        paddingAngle={2}
                      >
                        {overallProgressPie.map((e) => (
                          <Cell key={e.name} fill={e.color} stroke="rgba(0,0,0,0.35)" />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => [v, 'Trophies']} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : null}
              </div>
            </div>

            <div className="dashboard-panel" style={{ gridColumn: '1 / -1' }}>
              <h2>Per tier: unlocked vs locked (all games combined)</h2>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={tierStackedBar} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} allowDecimals={false} />
                    <Tooltip
                      formatter={(v: number, name: string) => [v, name === 'unlocked' ? 'Unlocked' : 'Locked']}
                      contentStyle={{
                        background: 'rgba(12,16,32,0.95)',
                        border: '1px solid var(--line)',
                        borderRadius: 8
                      }}
                    />
                    <Legend formatter={(v) => (v === 'unlocked' ? 'Unlocked' : 'Locked')} />
                    <Bar dataKey="unlocked" stackId="a" fill={COL.unlocked} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="locked" stackId="a" fill={COL.locked} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <h2
            style={{
              margin: '32px 0 14px',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--muted)'
            }}
          >
            Per game
          </h2>
          <div className="dashboard-games">
            {games.map((g) => {
              const locked = Math.max(0, g.totalTrophies - g.unlockedTrophies)
              const pie = [
                { name: 'Unlocked', value: g.unlockedTrophies, color: COL.unlocked },
                { name: 'Locked', value: locked, color: COL.locked }
              ].filter((x) => x.value > 0)
              const tierPie = [
                { name: 'Gold', value: g.tierTotal.gold, color: COL.gold },
                { name: 'Silver', value: g.tierTotal.silver, color: COL.silver },
                { name: 'Bronze', value: g.tierTotal.bronze, color: COL.bronze }
              ].filter((x) => x.value > 0)
              return (
                <div key={`${g.steamId}-${g.appId}`} className="game-card">
                  <div className="chart-wrap chart-wrap--sm" title="Progress">
                    {pie.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pie}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={36}
                            outerRadius={56}
                            paddingAngle={2}
                          >
                            {pie.map((e) => (
                              <Cell key={e.name} fill={e.color} stroke="rgba(0,0,0,0.35)" />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: number) => [v, '']} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : null}
                  </div>
                  <div className="chart-wrap chart-wrap--sm" title="Trophies by tier (total)">
                    {tierPie.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={tierPie}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={28}
                            outerRadius={52}
                            paddingAngle={2}
                          >
                            {tierPie.map((e) => (
                              <Cell key={e.name} fill={e.color} stroke="rgba(0,0,0,0.35)" />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: number) => [`${v} in tier`, '']} />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : null}
                  </div>
                  <div>
                    <h3>{g.gameName}</h3>
                    <div className="meta">
                      App {g.appId} · {g.progressPercent}% · {g.unlockedTrophies}/{g.totalTrophies}
                      {g.platinumEarned ? ' · Platinum' : ''}
                    </div>
                    <div className="game-tier-row">
                      <span className="gold">
                        Gold {g.tierUnlocked.gold}/{g.tierTotal.gold}
                      </span>
                      <span className="silver">
                        Silver {g.tierUnlocked.silver}/{g.tierTotal.silver}
                      </span>
                      <span className="bronze">
                        Bronze {g.tierUnlocked.bronze}/{g.tierTotal.bronze}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )
}
