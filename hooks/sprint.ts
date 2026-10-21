import type { AgentRow, Attempt, FinalVerdict, Lane, LaneStatus, PlanTicket, RunRow, Sprint, SprintStage } from '../types'

export const RUNG_OF: Record<string, number> = { 'haiku·low': 0, 'sonnet·medium': 1, 'sonnet·high': 2, 'top·high': 3, 'top·max': 4 }
export const KIND_MINUTES: Record<string, number> = { mechanical: 3, routine: 4, judgment: 6, hard: 9 }

const TICKET = /^(\S+) (build|review)(?: (\d+)\/(\d+))? \(([^)]+)\)$/
const DEFAULT_ATTEMPTS = 3
const DEFAULT_MINUTES = 6

export type Parsed = { id: string; role: 'build' | 'review'; n: number | null; of: number | null; tier: string }

export function isDecider(label: string): boolean {
  return label.startsWith('plan (') || label.startsWith('plan critic (') || label.startsWith('fix plan (')
}

const isFixPlan = (label: string): boolean => label.startsWith('fix plan (')

export function isCloser(label: string): boolean {
  return label.startsWith('integrate (') || label.startsWith('final review (')
}

export function parseLabel(label: string): Parsed | null {
  if (isDecider(label) || isCloser(label)) return null
  const m = TICKET.exec(label)
  if (!m) return null
  return {
    id: m[1] as string,
    role: m[2] as 'build' | 'review',
    n: m[3] === undefined ? null : Number(m[3]),
    of: m[4] === undefined ? null : Number(m[4]),
    tier: m[5] as string,
  }
}

export function liveAt(row: AgentRow, at: number): boolean {
  return row.startedAt <= at && (row.endedAt === null || row.endedAt > at)
}

const endedBy = (row: AgentRow, at: number): boolean => row.endedAt !== null && row.endedAt <= at

// Output tokens as of `at`: all of them once the row has ended, a straight-line share before its end. A row still
// running has written `out` by `now`, so a cursor before now gets the share of the time before the cursor.
function tokensAt(row: AgentRow, at: number, now: number): number {
  if (row.endedAt === null) {
    if (at >= now) return row.out
    return Math.round((row.out * Math.max(0, at - row.startedAt)) / Math.max(1, now - row.startedAt))
  }
  if (row.endedAt <= at) return row.out
  const span = row.endedAt - row.startedAt
  return span > 0 ? Math.round((row.out * Math.max(0, at - row.startedAt)) / span) : row.out
}

type Entry = { row: AgentRow; p: Parsed }

type Ticket = { id: string; title: string; kind: string; dependsOn: string[]; estimateMin: number | null; round: number }

function lastOf(rows: AgentRow[], prefix: string): AgentRow | null {
  let found: AgentRow | null = null
  for (const row of rows) if (row.label.startsWith(prefix)) found = row
  return found
}

function attemptsOf(entries: Entry[], run: RunRow, at: number): Attempt[] {
  const attempts: Attempt[] = []
  let order = 0
  for (const { row, p } of entries) {
    if (p.role !== 'build') continue
    order += 1
    attempts.push({ n: p.n ?? order, tier: p.tier, rung: RUNG_OF[p.tier] ?? -1, build: row, review: null, verdict: null })
  }
  for (const { row, p } of entries) {
    if (p.role !== 'review') continue
    let target: Attempt | undefined
    if (p.n !== null) target = attempts.find(a => a.n === p.n)
    else {
      for (const a of attempts) if (a.build && a.build.startedAt <= row.startedAt) target = a
    }
    if (!target) {
      target = { n: p.n ?? attempts.length + 1, tier: p.tier, rung: RUNG_OF[p.tier] ?? -1, build: null, review: null, verdict: null }
      attempts.push(target)
    }
    target.review = row
    target.verdict = endedBy(row, at) ? run.verdicts[row.id] ?? null : null
  }
  return attempts.sort((a, b) => a.n - b.n)
}

// The verdict the shown round's own final review gave: none when it gave none (it failed, or the run was
// stopped first). A deck saved before verdicts were kept per review falls back to the run's last verdict.
function finalOf(run: RunRow, review: AgentRow | null): FinalVerdict | null {
  const finals = run.finals ?? {}
  if (!Object.keys(finals).length) return review ? run.final : null
  return review ? finals[review.id] ?? null : null
}

const VERDICT_RANK: Record<string, number> = { ship: 0, 'fix first': 1, block: 2 }

// Several final reviewers in one round count as one review: the worst verdict any of them gave, block over fix first
// over ship, with the summary of that worst one. A reviewer that gave no verdict does not count.
function mergedFinal(run: RunRow, reviews: AgentRow[]): FinalVerdict | null {
  let worst: FinalVerdict | null = null
  for (const review of reviews) {
    const v = finalOf(run, review)
    if (v && (worst === null || (VERDICT_RANK[v.verdict] ?? 0) > (VERDICT_RANK[worst.verdict] ?? 0))) worst = v
  }
  return worst
}

export function sprintOf(run: RunRow, rows: readonly AgentRow[], at: number, now: number = at): Sprint | null {
  const all = rows.filter(row => row.runId === run.id)
  const byStart = (a: AgentRow, b: AgentRow) => a.index - b.index || a.startedAt - b.startedAt
  const mine = all.filter(row => row.startedAt <= at).sort(byStart)

  const deciders = mine.filter(row => isDecider(row.label))

  // Rounds: a fix plan that starts after a closer has started opens the next round.
  const chrono = [...all].sort((a, b) => a.startedAt - b.startedAt || a.index - b.index)
  let firstCloser: number | null = null
  const openers: AgentRow[] = []
  for (const row of chrono) {
    if (isCloser(row.label) && firstCloser === null) firstCloser = row.startedAt
    else if (isFixPlan(row.label) && firstCloser !== null && firstCloser < row.startedAt) openers.push(row)
  }
  const roundOf = (row: AgentRow): number => openers.filter(o => o.startedAt <= row.startedAt).length
  const round = openers.filter(o => o.startedAt <= at).length
  const opener = round > 0 ? (openers[round - 1] as AgentRow) : null
  const allClosers = mine.filter(row => isCloser(row.label))
  const closersIn = (r: number): AgentRow[] => allClosers.filter(row => roundOf(row) === r)
  const closers = closersIn(round)
  const laneRows: Entry[] = []
  for (const row of mine) {
    const p = parseLabel(row.label)
    if (p) laneRows.push({ row, p })
  }

  const labelIds: string[] = []
  for (const { p } of laneRows) if (!labelIds.includes(p.id)) labelIds.push(p.id)
  const everyLabelId = new Set<string>()
  for (const row of all) {
    const p = parseLabel(row.label)
    if (p) everyLabelId.add(p.id)
  }
  if (run.plan === null && !all.some(row => isDecider(row.label)) && everyLabelId.size < 2) return null

  const producerPrefix = run.planFrom === 'critic' ? 'plan critic (' : 'plan ('
  const producer = lastOf([...all].sort(byStart), producerPrefix)
  const known = run.plan !== null && (producer === null || endedBy(producer, at))
  const plannerTickets: PlanTicket[] | null = run.draft ?? (run.planFrom === 'planner' && run.plan !== null ? run.plan.filter(t => !t.from) : null)
  const draft = plannerTickets !== null && all.some(row => row.label.startsWith('plan critic (') && liveAt(row, at))
  const base = known || draft
  const rowById = new Map(all.map(row => [row.id, row]))
  const shown = (t: PlanTicket): boolean => {
    if (!t.from) return base
    const from = rowById.get(t.from)
    return !from || endedBy(from, at)
  }
  const roundOfTicket = (t: PlanTicket): number => {
    if (!t.from) return 0
    const from = rowById.get(t.from)
    return from ? roundOf(from) : openers.length
  }
  const plan: PlanTicket[] = draft ? (plannerTickets as PlanTicket[]) : run.plan === null ? [] : run.plan.filter(shown)
  const kept = new Set(plan.filter(t => !t.dropped).map(t => t.id))
  const droppedIds = new Set(plan.filter(t => t.dropped && !kept.has(t.id)).map(t => t.id))

  const tickets: Ticket[] = []
  const seen = new Set<string>(droppedIds)
  for (const t of plan) {
    if (t.dropped || seen.has(t.id)) continue
    seen.add(t.id)
    tickets.push({ id: t.id, title: t.title, kind: t.kind, dependsOn: t.dependsOn, estimateMin: t.estimateMin, round: roundOfTicket(t) })
  }
  for (const id of labelIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const first = laneRows.find(e => e.p.id === id) as Entry
    tickets.push({ id, title: id, kind: 'judgment', dependsOn: [], estimateMin: null, round: roundOf(first.row) })
  }

  const runEnded = run.endedAt !== null && run.endedAt <= at
  const closerStarted = (r: number): boolean => closersIn(r).length > 0
  const ids = new Set(tickets.map(t => t.id))

  const entriesOf = new Map<string, Entry[]>()
  for (const e of laneRows) {
    const list = entriesOf.get(e.p.id)
    if (list) list.push(e)
    else entriesOf.set(e.p.id, [e])
  }

  type Built = { t: Ticket; entries: Entry[]; attempts: Attempt[]; maxAttempts: number; own: LaneStatus | null; deps: string[] }
  const built = new Map<string, Built>()
  for (const t of tickets) {
    const entries = entriesOf.get(t.id) ?? []
    const attempts = attemptsOf(entries, run, at)
    const maxAttempts = entries.reduce((m, e) => (e.p.of !== null && e.p.of > m ? e.p.of : m), 0) || DEFAULT_ATTEMPTS
    const deps = t.dependsOn.filter(d => d !== t.id && ids.has(d))
    let own: LaneStatus | null = null
    if (attempts.some(a => a.verdict?.pass)) own = 'passed'
    else if (entries.length > 0) {
      let latest: Entry | null = null
      for (const e of entries) if (!latest || e.row.startedAt >= latest.row.startedAt) latest = e
      const last = attempts[attempts.length - 1]
      const review = last?.review ?? null
      const spent =
        attempts.length >= maxAttempts &&
        review !== null &&
        endedBy(review, at) &&
        (last?.verdict ? !last.verdict.pass : review.outcome !== 'done')
      if (latest && liveAt(latest.row, at)) own = latest.p.role === 'build' ? 'building' : 'reviewing'
      else if (spent || runEnded || closerStarted(t.round)) own = 'failed'
      else own = 'building'
    }
    built.set(t.id, { t, entries, attempts, maxAttempts, own, deps })
  }

  const resolved = new Map<string, LaneStatus>()
  const visiting = new Set<string>()
  const statusOf = (id: string): LaneStatus => {
    const done = resolved.get(id)
    if (done) return done
    const b = built.get(id)
    if (!b) return 'waiting'
    if (b.own) {
      resolved.set(id, b.own)
      return b.own
    }
    if (visiting.has(id)) return 'waiting'
    visiting.add(id)
    const deps = b.deps.map(statusOf)
    visiting.delete(id)
    let status: LaneStatus
    const lost = b.t.dependsOn.some(d => droppedIds.has(d))
    if (lost || deps.some(s => s === 'failed' || s === 'skipped') || closerStarted(b.t.round) || runEnded) status = 'skipped'
    else if (deps.every(s => s === 'passed')) status = 'ready'
    else status = 'waiting'
    if (visiting.size === 0) resolved.set(id, status)
    return status
  }

  const lanes: Lane[] = tickets.map(t => {
    const b = built.get(t.id) as Built
    const status = statusOf(t.id)
    const laneRowList = b.entries.map(e => e.row)
    const firstBuild = b.attempts.find(a => a.build)?.build ?? null
    const first = laneRowList[0] ?? null
    let endedAt: number | null = null
    if (status === 'passed') {
      const passing = b.attempts.find(a => a.verdict?.pass)
      endedAt = passing?.review?.endedAt ?? null
    } else if (status === 'failed') {
      for (const row of laneRowList) if (endedBy(row, at) && (endedAt === null || (row.endedAt as number) > endedAt)) endedAt = row.endedAt
    }
    let live: AgentRow | null = null
    for (const row of laneRowList) if (liveAt(row, at) && (!live || row.startedAt >= live.startedAt)) live = row
    return {
      id: t.id,
      title: t.title,
      kind: t.kind,
      dependsOn: t.dependsOn,
      estimateMin: t.estimateMin ?? KIND_MINUTES[t.kind] ?? DEFAULT_MINUTES,
      status,
      attempts: b.attempts,
      maxAttempts: b.maxAttempts,
      startedAt: firstBuild ? firstBuild.startedAt : first ? first.startedAt : null,
      endedAt,
      tokens: laneRowList.reduce((sum, row) => sum + tokensAt(row, at, now), 0),
      live,
    }
  })

  const integrate = lastOf(closers, 'integrate (')
  const finalReviews = closers.filter(row => row.label.startsWith('final review ('))
  let stage: SprintStage
  if (runEnded || (finalReviews.length > 0 && finalReviews.every(row => endedBy(row, at)))) stage = 'done'
  else if (finalReviews.some(row => liveAt(row, at)) || (integrate !== null && endedBy(integrate, at) && finalReviews.length === 0)) stage = 'reviewing'
  else if (integrate !== null && liveAt(integrate, at)) stage = 'integrating'
  else if (draft || lanes.length === 0) stage = 'deciding'
  else if (opener !== null && (liveAt(opener, at) || !tickets.some((t, i) => t.round === round && lanes[i]?.startedAt != null))) stage = 'deciding'
  else stage = 'building'

  const final: FinalVerdict | null = stage === 'done' ? mergedFinal(run, finalReviews) : null
  // The previous round's merged verdict. A deck saved before verdicts were kept per review has only the run's last
  // verdict, which belongs to the previous round only while no later round has a final review of its own.
  const previousReviews = round > 0 ? closersIn(round - 1).filter(row => row.label.startsWith('final review (')) : []
  const laterReview = all.some(row => row.label.startsWith('final review (') && roundOf(row) >= round)
  const previous: FinalVerdict | null = round === 0 || previousReviews.length === 0
    ? null
    : Object.keys(run.finals ?? {}).length || !laterReview ? mergedFinal(run, previousReviews) : null
  return {
    runId: run.id,
    name: run.name,
    startedAt: run.startedAt,
    endedAt: runEnded ? run.endedAt : null,
    at,
    stage,
    round,
    draft,
    tokens: mine.reduce((sum, row) => sum + tokensAt(row, at, now), 0),
    previous,
    lanes,
    deciders,
    closers,
    final,
  }
}
