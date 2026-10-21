import type { AgentRow, Deck, Forecast, Lane, RunRow, Sprint } from '../types'
import * as D from './deck'
import { parseLabel } from './sprint'

const SEP = ' · '

function chain(ids: string[]): string {
  const shown = ids.length > 4 ? [...ids.slice(0, 2), '…', ...ids.slice(-1)] : ids
  return shown.join(' → ')
}

function minutesLeft(s: Sprint, f: Forecast): string[] {
  if (f.eta === null) return []
  return [`about ${Math.max(1, Math.round((f.eta - s.at) / 60000))} min left`]
}

// How long an agent has worked as of the moment shown: in a replay, up to the cursor, never past it.
function worked(s: Sprint, row: AgentRow | undefined): number {
  if (!row) return Math.max(0, s.at - s.startedAt)
  return Math.max(0, Math.min(row.endedAt ?? s.at, s.at) - row.startedAt)
}

function count(lanes: Lane[], status: Lane['status']): number {
  return lanes.filter(l => l.status === status).length
}

function waitingOn(s: Sprint, f: Forecast, passed: number): string | null {
  const entry = f.longPole === null ? undefined : f.waiting.find(w => w.on === f.longPole)
  if (!entry) return null
  const lane = s.lanes.find(l => l.id === entry.on)
  const last = lane?.attempts[lane.attempts.length - 1]
  const since = last ? (last.build?.startedAt ?? last.review?.startedAt ?? null) : null
  const tier = (lane?.live ? parseLabel(lane.live.label)?.tier : undefined) ?? last?.tier
  const inside = tier ? ` (${tier}${since === null ? '' : `, ${D.clock(Math.max(0, s.at - since))} in`})` : ''
  const parts = [`Waiting on ${entry.on}${inside}`]
  if (entry.blocked.length) parts.push(`${entry.blocked.length} ${entry.blocked.length === 1 ? 'ticket' : 'tickets'} behind it`)
  parts.push(`${passed} of ${s.lanes.length} passed`)
  parts.push(...minutesLeft(s, f))
  if (lane?.title) parts.push(lane.title)
  return parts.join(SEP)
}

export function headline(s: Sprint, f: Forecast): string {
  const text = headlineBody(s, f)
  const stage = s.stage === 'building' || s.stage === 'integrating' || s.stage === 'reviewing'
  return stage && s.round > 0 ? `Fix round ${s.round}${SEP}${text}` : text
}

function headlineBody(s: Sprint, f: Forecast): string {
  const passed = count(s.lanes, 'passed')
  const total = s.lanes.length
  switch (s.stage) {
    case 'deciding': {
      const newest = s.deciders.reduce<AgentRow | undefined>((a, r) => (!a || r.startedAt > a.startedAt ? r : a), undefined)
      if (newest && newest.label.startsWith('fix plan (')) {
        const parts = [`Planning fixes: the triage agent has worked ${D.clock(worked(s, newest))}`]
        if (total > 0) parts.push(`${passed} of ${total} passed`)
        return parts.join(SEP)
      }
      if (newest && newest.label.startsWith('plan critic (')) {
        const parts = [`Checking the plan: the critic has worked ${D.clock(worked(s, newest))}`]
        if (total > 0) parts.push(`the draft has ${total} ${total === 1 ? 'ticket' : 'tickets'}`)
        return parts.join(SEP)
      }
      if (s.draft) {
        const critic = s.deciders.find(r => r.label.startsWith('plan critic ('))
        return [`Checking the plan: the critic has worked ${D.clock(worked(s, critic))}`, `the draft has ${total} ${total === 1 ? 'ticket' : 'tickets'}`].join(SEP)
      }
      const planner = s.deciders.find(r => r.label.startsWith('plan ('))
      return `Planning: the planner has worked ${D.clock(worked(s, planner))}`
    }
    case 'building': {
      const pole = waitingOn(s, f, passed)
      if (pole) return pole
      const working = count(s.lanes, 'building') + count(s.lanes, 'reviewing')
      const parts = [`${passed} of ${total} passed`, `${working} working`]
      if (f.criticalPath.length) parts.push(`longest chain ${chain(f.criticalPath)}`)
      return parts.concat(minutesLeft(s, f)).join(SEP)
    }
    case 'integrating': {
      const failed = count(s.lanes, 'failed')
      const settled = `Tickets settled: ${passed} passed${failed ? `, ${failed} failed` : ''}`
      const closer = s.closers.find(r => r.label.startsWith('integrate ('))
      return [settled, `integrating ${D.clock(worked(s, closer))}`].concat(minutesLeft(s, f)).join(SEP)
    }
    case 'reviewing': {
      const reviewers = s.closers.filter(r => r.label.startsWith('final review ('))
      const since = reviewers.length ? Math.min(...reviewers.map(r => r.startedAt)) : s.startedAt
      const live = reviewers.filter(r => r.endedAt === null || r.endedAt > s.at).length
      const lead = live > 1 ? `${live} final reviewers running` : 'Final review running'
      return [`${lead} ${D.clock(Math.max(0, s.at - since))}`].concat(minutesLeft(s, f)).join(SEP)
    }
    default: {
      const took = D.clock(Math.max(0, (s.endedAt ?? f.eta ?? s.at) - s.startedAt))
      const parts = s.final ? [`Final review: ${s.final.verdict}`, `finished in ${took}`] : [`Finished in ${took}`]
      parts.push(`${passed} of ${total} passed`)
      const lanes = f.criticalPath.map(id => s.lanes.find(l => l.id === id)).filter((l): l is Lane => !!l)
      const first = lanes[0]
      const last = lanes[lanes.length - 1]
      if (first && last) {
        const from = first.startedAt
        const to = last.endedAt
        parts.push(`longest chain ${chain(f.criticalPath)}${from === null || to === null ? '' : ` took ${D.clock(to - from)}`}`)
      }
      if (f.factor !== 1) parts.push(`tickets took ${f.factor.toFixed(1)}× their estimates on average`)
      return parts.join(SEP)
    }
  }
}

export function burn(run: RunRow, usage: Deck['usage'], f: Forecast, at: number): { text: string; level: 'ok' | 'warn' | 'over' } | null {
  const base = run.limitBase
  const cur = usage?.fiveHour
  if (!base || !cur) return null
  const elapsed = at - run.startedAt
  if (elapsed < 60000) return null
  if (Math.abs(cur.resetsAt - base.resetsAt) > 2 * 60000) return { text: 'Your 5-hour limit window reset during this sprint', level: 'ok' }
  const text = `5-hour limit ${Math.round(base.pct)}% → ${Math.round(cur.pct)}% since this sprint started`
  const tail = ` · ${Math.round(base.pct)}% → ${Math.round(cur.pct)}% so far`
  const rise = cur.pct - base.pct
  if (f.eta !== null && f.eta > at && rise > 0) {
    const proj = cur.pct + (rise * (f.eta - at)) / elapsed
    if (proj >= 100) {
      const mins = Math.max(1, Math.round((((100 - cur.pct) / rise) * elapsed) / 60000))
      return { text: `5-hour limit runs out in about ${mins} min, before the sprint ends${tail}`, level: 'over' }
    }
    return { text: `5-hour limit about ${Math.round(proj)}% by the end${tail}`, level: proj >= 80 ? 'warn' : 'ok' }
  }
  return { text, level: 'ok' }
}
