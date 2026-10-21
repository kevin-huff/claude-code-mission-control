import type { AgentRow, Cursor, Deck, Forecast, RunRow, Sprint } from '../types'
import { forecast } from './forecast'
import { compact, P } from './look'
import { sprintOf } from './sprint'

export type SprintView = { run: RunRow; s: Sprint; f: Forecast; at: number; replaying: boolean; now?: number }

export function viewAt(run: RunRow, rows: readonly AgentRow[], cursor: Cursor, now: number): SprintView | null {
  const replaying = cursor !== null && cursor.runId === run.id
  const at = replaying && cursor ? Math.min(Math.max(cursor.at, run.startedAt), run.endedAt ?? now) : now
  const s = sprintOf(run, rows, at, now)
  if (!s) return null
  return { run, s, f: forecast(s, at), at, replaying, now }
}

export function sprintViews(deck: Deck, cursor: Cursor): SprintView[] {
  const now = deck.at
  const views: SprintView[] = []
  const runs = [...deck.runs].sort((a, b) => b.startedAt - a.startedAt)
  for (const run of runs) {
    const v = viewAt(run, deck.agents.filter(row => row.runId === run.id), cursor, now)
    if (v) views.push(v)
  }
  return views
}

export const HERO_RECENT_MS = 5 * 60_000

export function pickHero(views: SprintView[]): SprintView | null {
  // The lead is judged by the run's own end and the deck's time, never by the replay cursor.
  const recent = views.find(v => v.run.endedAt !== null && (v.now ?? v.at) - v.run.endedAt <= HERO_RECENT_MS)
  const lead = views.find(v => v.run.endedAt === null) ?? recent ?? null
  return lead ? (views.find(v => v.replaying) ?? lead) : null
}

export function minutesLeft(v: SprintView): number | null {
  if (v.f.eta === null || v.s.stage === 'done') return null
  return Math.max(1, Math.round((v.f.eta - v.at) / 60000))
}

export function heroTiles(v: SprintView): { label: string; value: string; color: string }[] {
  const lanes = v.s.lanes
  const count = (...states: string[]) => lanes.filter(l => states.includes(l.status)).length
  const retries = lanes.reduce((n, l) => n + Math.max(0, l.attempts.length - 1), 0)
  const left = minutesLeft(v)
  return [
    { label: `PASSED OF ${lanes.length}`, value: String(count('passed')), color: P.green },
    { label: 'MIN LEFT', value: left === null ? '-' : String(left), color: P.peach },
    { label: 'WORKING', value: String(count('building', 'reviewing')), color: P.blue },
    { label: 'WAITING', value: String(count('waiting')), color: P.over1 },
    { label: 'RETRIES', value: String(retries), color: retries > 0 ? P.yellow : P.over0 },
    { label: 'TOKENS OUT', value: compact(v.s.tokens), color: P.mauve },
  ]
}

export function heroStatus(v: SprintView): string {
  if (v.s.stage === 'done') return 'sprint done'
  const left = minutesLeft(v)
  if (left === null) return 'planning'
  const passed = v.s.lanes.filter(l => l.status === 'passed').length
  return `${passed} of ${v.s.lanes.length} passed · ${left}m left`
}

export function laneRowIds(v: SprintView): Set<string> {
  const ids = new Set<string>()
  for (const lane of v.s.lanes) {
    for (const a of lane.attempts) {
      if (a.build) ids.add(a.build.id)
      if (a.review) ids.add(a.review.id)
    }
  }
  return ids
}
