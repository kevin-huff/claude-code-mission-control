import type { AgentRow, Forecast, Lane, Projection, Sprint } from '../types'

export const INTEGRATE_MIN = 12
export const FINAL_MIN = 18

const MIN = 60000

const est = (l: Lane): number => Math.max(0, l.estimateMin || 0) * MIN

const unfinished = (l: Lane): boolean =>
  l.status === 'building' || l.status === 'reviewing' || l.status === 'ready' || l.status === 'waiting'

const running = (l: Lane): boolean => l.status === 'building' || l.status === 'reviewing'

function factorOf(lanes: Lane[]): number {
  const done = lanes.filter(l => l.status === 'passed' && l.startedAt !== null && l.endedAt !== null)
  if (!done.length) return 1
  const m = lanes.reduce((a, l) => a + est(l), 0) / lanes.length
  const took = done.reduce((a, l) => a + ((l.endedAt as number) - (l.startedAt as number)), 0)
  const planned = done.reduce((a, l) => a + est(l), 0)
  const den = planned + 2 * m
  if (den <= 0) return 1
  return Math.min(3, Math.max(0.5, (took + 2 * m) / den))
}

function depsOf(l: Lane, ids: Set<string>): string[] {
  const out: string[] = []
  for (const d of l.dependsOn) if (d !== l.id && ids.has(d) && !out.includes(d)) out.push(d)
  return out
}

function order(lanes: Lane[], deps: Map<string, string[]>): string[] {
  const indeg = new Map<string, number>()
  const users = new Map<string, string[]>()
  for (const l of lanes) {
    indeg.set(l.id, (deps.get(l.id) ?? []).length)
    for (const d of deps.get(l.id) ?? []) users.set(d, [...(users.get(d) ?? []), l.id])
  }
  const queue = lanes.filter(l => indeg.get(l.id) === 0).map(l => l.id)
  const out: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const u of users.get(id) ?? []) {
      const n = (indeg.get(u) ?? 0) - 1
      indeg.set(u, n)
      if (n === 0) queue.push(u)
    }
  }
  for (const l of lanes) if (!seen.has(l.id)) {
    seen.add(l.id)
    out.push(l.id)
  }
  return out
}

const liveAt = (row: AgentRow, at: number): boolean =>
  row.startedAt <= at && (row.endedAt === null || row.endedAt > at)

function lastCloser(s: Sprint, prefix: string): AgentRow | null {
  let found: AgentRow | null = null
  for (const r of s.closers) if (r.label.startsWith(prefix)) found = r
  return found
}

function longestActual(byId: Map<string, Lane>, ord: string[], deps: Map<string, string[]>): string[] {
  const minutes = new Map<string, number>()
  const prev = new Map<string, string | null>()
  for (const id of ord) {
    const l = byId.get(id) as Lane
    if (l.status === 'skipped' || l.startedAt === null || l.endedAt === null) continue
    let best = 0
    let from: string | null = null
    for (const d of deps.get(id) ?? []) {
      const v = minutes.get(d)
      if (v !== undefined && v > best) {
        best = v
        from = d
      }
    }
    minutes.set(id, best + (l.endedAt - l.startedAt))
    prev.set(id, from)
  }
  let tail: string | null = null
  for (const [id, v] of minutes) if (tail === null || v > (minutes.get(tail) as number)) tail = id
  const path: string[] = []
  const seen = new Set<string>()
  for (let id = tail; id !== null && !seen.has(id); id = prev.get(id) ?? null) {
    seen.add(id)
    path.push(id)
  }
  return path.reverse()
}

export function forecast(s: Sprint, at: number): Forecast {
  const lanes = s.lanes
  const byId = new Map<string, Lane>()
  for (const l of lanes) if (!byId.has(l.id)) byId.set(l.id, l)
  const ids = new Set(byId.keys())
  const deps = new Map<string, string[]>()
  for (const l of byId.values()) deps.set(l.id, depsOf(l, ids))
  const ord = order([...byId.values()], deps)
  const pos = new Map(ord.map((id, i) => [id, i]))
  const factor = factorOf(lanes)
  const dur = (l: Lane): number => est(l) * factor

  const proj = new Map<string, Projection>()
  for (const id of ord) {
    const l = byId.get(id) as Lane
    let depFinish: number | null = null
    let after: string | null = null
    for (const d of deps.get(id) ?? []) {
      const p = proj.get(d)
      if (!p || byId.get(d)?.status === 'skipped') continue
      if (depFinish === null || p.finish > depFinish) {
        depFinish = p.finish
        after = d
      }
    }
    let start: number
    let finish: number
    if (l.status === 'passed' || l.status === 'failed') {
      start = l.startedAt ?? at
      finish = l.endedAt ?? at
    } else if (l.status === 'skipped') {
      start = finish = Math.min(at, depFinish ?? at)
    } else if (running(l)) {
      const last = l.attempts.length ? l.attempts[l.attempts.length - 1] : null
      const attemptStart = last?.build?.startedAt ?? last?.review?.startedAt ?? l.startedAt ?? at
      const d = dur(l)
      const retrying = !l.live && last?.verdict != null && !last.verdict.pass
      const elapsed = at - attemptStart
      const remaining = retrying ? d : Math.max(d - elapsed, 0.25 * elapsed)
      start = l.startedAt ?? attemptStart
      finish = at + Math.max(remaining, 1)
    } else {
      start = Math.max(at, depFinish ?? at)
      finish = start + dur(l)
    }
    proj.set(id, { id, start, finish, slackMs: 0, critical: false, after })
  }

  let tail: string | null = null
  let maxFinish: number | null = null
  for (const l of byId.values()) {
    if (l.status === 'skipped') continue
    const f = (proj.get(l.id) as Projection).finish
    if (maxFinish === null || f > maxFinish) {
      maxFinish = f
      tail = l.id
    }
  }
  const buildEnd = s.stage === 'deciding' ? null : maxFinish

  // A finished sprint that had a fix round ends on a fix ticket, which says nothing about how the sprint
  // went, so its longest chain is the one with the most actual minutes along its dependencies.
  const criticalPath: string[] = s.stage === 'done' && s.round > 0 ? longestActual(byId, ord, deps) : []
  const onPath = new Set<string>(criticalPath)
  if (!criticalPath.length) {
    for (let id = tail; id !== null && !onPath.has(id); id = (proj.get(id) as Projection).after) {
      onPath.add(id)
      criticalPath.push(id)
    }
    criticalPath.reverse()
  }

  const horizon = buildEnd ?? maxFinish ?? at
  const lf = new Map<string, number>()
  const users = new Map<string, string[]>()
  for (const id of ord) for (const d of deps.get(id) ?? []) {
    if ((pos.get(d) as number) < (pos.get(id) as number)) users.set(d, [...(users.get(d) ?? []), id])
  }
  for (let i = ord.length - 1; i >= 0; i--) {
    const id = ord[i] as string
    let best: number | null = null
    for (const u of users.get(id) ?? []) {
      const ul = byId.get(u) as Lane
      if (!unfinished(ul)) continue
      const p = proj.get(u) as Projection
      const v = (lf.get(u) as number) - (p.finish - p.start)
      if (best === null || v < best) best = v
    }
    lf.set(id, best ?? horizon)
  }

  const projections: Record<string, Projection> = {}
  for (const id of ord) {
    const l = byId.get(id) as Lane
    const p = proj.get(id) as Projection
    const critical = onPath.has(id)
    const slackMs = !critical && unfinished(l) ? Math.max(0, (lf.get(id) as number) - p.finish) : 0
    projections[id] = { ...p, critical, slackMs }
  }

  const longPole =
    criticalPath.find(id => running(byId.get(id) as Lane)) ??
    criticalPath.find(id => unfinished(byId.get(id) as Lane)) ??
    null

  const holders = new Map<string, string[]>()
  for (const l of byId.values()) {
    if (l.status !== 'waiting') continue
    const seen = new Set<string>([l.id])
    let next = (proj.get(l.id) as Projection).after
    let holder: string | null = null
    while (next !== null && !seen.has(next)) {
      const nl = byId.get(next) as Lane
      if (nl.status === 'waiting') {
        seen.add(next)
        next = (proj.get(next) as Projection).after
        continue
      }
      if (unfinished(nl)) holder = next
      break
    }
    if (holder !== null) holders.set(holder, [...(holders.get(holder) ?? []), l.id])
  }
  const waiting = [...holders.entries()]
    .map(([on, blocked]) => ({ on, blocked }))
    .sort((a, b) => b.blocked.length - a.blocked.length)

  return { at, factor, projections, criticalPath, longPole, waiting, buildEnd, eta: etaOf(s, at, buildEnd) }
}

function etaOf(s: Sprint, at: number, buildEnd: number | null): number | null {
  if (s.stage === 'deciding') return null
  const INTEGRATE = INTEGRATE_MIN * MIN
  const FINAL = FINAL_MIN * MIN
  if (s.stage === 'done') {
    if (s.endedAt !== null) return s.endedAt
    let end: number | null = null
    for (const r of s.closers) if (r.endedAt !== null && (end === null || r.endedAt > end)) end = r.endedAt
    return end ?? buildEnd
  }
  const integrate = lastCloser(s, 'integrate (')
  const reviews = s.closers.filter(r => r.label.startsWith('final review ('))
  let final: { startedAt: number; endedAt: number | null; live: boolean } | null = null
  if (reviews.length) {
    const startedAt = Math.min(...reviews.map(r => r.startedAt))
    const over = reviews.every(r => r.endedAt !== null && r.endedAt <= at)
    final = {
      startedAt,
      endedAt: over ? Math.max(...reviews.map(r => r.endedAt as number)) : null,
      live: reviews.some(r => liveAt(r, at)),
    }
  }
  if (final && final.live) return at + Math.max(FINAL - (at - final.startedAt), 0.25 * (at - final.startedAt), MIN)
  if (final && final.endedAt !== null) return final.endedAt
  if (integrate && liveAt(integrate, at)) return at + Math.max(INTEGRATE - (at - integrate.startedAt), 0.25 * (at - integrate.startedAt), MIN) + FINAL
  if (integrate && integrate.endedAt !== null && integrate.endedAt <= at && (!final || final.startedAt > at)) return at + FINAL
  const end = Math.max(buildEnd ?? at, at)
  const settled = s.lanes.length > 0 && s.lanes.every(l => !unfinished(l))
  if (settled && !s.lanes.some(l => l.status === 'passed')) return end
  return end + INTEGRATE + FINAL
}
