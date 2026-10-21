import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { forecast } from '../hooks/forecast'
import { headline } from '../hooks/headline'
import { heroTiles, minutesLeft } from '../hooks/hero'
import { sprintOf } from '../hooks/sprint'
import type { AgentRow, PlanTicket, RunRow, Verdict } from '../types'

const SEC = 1000
type World = { store: D.Store; run: RunRow; rows: AgentRow[]; next: number }
const world = (): World => ({ store: D.createStore(), run: undefined as never, rows: [], next: 1 })
const add = (w: World, label: string, start: number, end: number | null = null): AgentRow => {
  const id = `a${w.next}`
  D.spawned(w.store, { agentId: id, description: label, subagentType: 'workflow-subagent', model: 'claude-opus-5-5', runId: 'wf_s', index: w.next, toolUseId: 'toolu_wf', isTeammate: false }, start * SEC)
  w.next += 1
  if (end !== null) D.turnEnded(w.store, id, 'answer', end * SEC)
  w.run = w.store.runs.get('wf_s') as RunRow
  w.rows = [...w.store.agents.values()]
  return w.store.agents.get(id) as AgentRow
}
const tk = (id: string): PlanTicket => ({ id, title: `title ${id}`, kind: 'judgment', dependsOn: [], estimateMin: 4 })
const pass: Verdict = { pass: true, summary: 'ok', issue: '' }

function threeReviewers() {
  const w = world()
  add(w, 'plan (top·max)', 0, 50)
  add(w, 'T1 build 1/3 (sonnet·high)', 60, 100)
  const r1 = add(w, 'T1 review 1/3 (top·high)', 100, 130)
  w.run.plan = [tk('T1')]
  w.run.planFrom = 'planner'
  w.run.verdicts[r1.id] = pass
  add(w, 'integrate (top·high)', 140, 200)
  const a = add(w, 'final review (top·max)', 300)
  const b = add(w, 'final review (top·max)', 300)
  const c = add(w, 'final review (top·max)', 300)
  return { w, a, b, c }
}

const at = 900 * SEC
const look = (w: World, now = at) => {
  const s = sprintOf(w.run, w.rows, now)!
  const f = forecast(s, now)
  return { s, f, v: { run: w.run, s, f, at: now, replaying: false } }
}
const refresh = (w: World) => {
  w.rows = [...w.store.agents.values()]
}

test('three reviewers, last-started ended: forecast stays ahead and matches the headline and tile', () => {
  const { w, c } = threeReviewers()
  D.turnEnded(w.store, c.id, 'answer', 360 * SEC)
  refresh(w)
  const { s, f, v } = look(w)
  expect(s.stage).toBe('reviewing')
  expect((f.eta as number) - at).toBe(8 * 60 * SEC)
  expect(headline(s, f)).toBe('2 final reviewers running 10:00 \u00b7 about 8 min left')
  expect(heroTiles(v).find(t => t.label === 'MIN LEFT')?.value).toBe('8')
  expect(minutesLeft(v)).toBe(8)
})

test('three reviewers give the same minutes left as a single reviewer at the same moment', () => {
  const { w, c } = threeReviewers()
  D.turnEnded(w.store, c.id, 'answer', 360 * SEC)
  refresh(w)
  const many = look(w)
  const one = world()
  add(one, 'plan (top\u00b7max)', 0, 50)
  add(one, 'T1 build 1/3 (sonnet\u00b7high)', 60, 100)
  const r1 = add(one, 'T1 review 1/3 (top\u00b7high)', 100, 130)
  one.run.plan = [tk('T1')]
  one.run.planFrom = 'planner'
  one.run.verdicts[r1.id] = pass
  add(one, 'integrate (top\u00b7high)', 140, 200)
  add(one, 'final review (top\u00b7max)', 300)
  const single = look(one)
  expect(many.f.eta).toBe(single.f.eta)
  expect(heroTiles(many.v).find(t => t.label === 'MIN LEFT')?.value).toBe(heroTiles(single.v).find(t => t.label === 'MIN LEFT')?.value)
  expect(headline(single.s, single.f)).toBe('Final review running 10:00 \u00b7 about 8 min left')
})

test('earliest-started reviewer ends first: the clock keeps counting from the earliest start', () => {
  const w = world()
  add(w, 'plan (top\u00b7max)', 0, 50)
  add(w, 'T1 build 1/3 (sonnet\u00b7high)', 60, 100)
  const r1 = add(w, 'T1 review 1/3 (top\u00b7high)', 100, 130)
  w.run.plan = [tk('T1')]
  w.run.planFrom = 'planner'
  w.run.verdicts[r1.id] = pass
  add(w, 'integrate (top\u00b7high)', 140, 200)
  const a = add(w, 'final review (top\u00b7max)', 300)
  add(w, 'final review (top\u00b7max)', 330)
  add(w, 'final review (top\u00b7max)', 360)
  D.turnEnded(w.store, a.id, 'answer', 400 * SEC)
  refresh(w)
  const { s, f } = look(w)
  expect(s.stage).toBe('reviewing')
  expect(headline(s, f)).toBe('2 final reviewers running 10:00 \u00b7 about 8 min left')
  expect(f.eta).toBe(at + 8 * 60 * SEC)
})

test('a lone live reviewer among ended ones reads as one final review, clock from the earliest start', () => {
  const { w, a, b } = threeReviewers()
  D.turnEnded(w.store, a.id, 'answer', 400 * SEC)
  D.turnEnded(w.store, b.id, 'answer', 420 * SEC)
  refresh(w)
  const { s, f } = look(w)
  expect(headline(s, f)).toBe('Final review running 10:00 \u00b7 about 8 min left')
})

test('once all three have ended, the forecast ends at the latest end', () => {
  const { w, a, b, c } = threeReviewers()
  D.turnEnded(w.store, a.id, 'answer', 400 * SEC)
  D.turnEnded(w.store, c.id, 'answer', 700 * SEC)
  D.turnEnded(w.store, b.id, 'answer', 500 * SEC)
  refresh(w)
  const { f } = look(w, 800 * SEC)
  expect(f.eta).toBe(700 * SEC)
  const { f: mid } = look(w, 600 * SEC)
  expect((mid.eta as number) > 600 * SEC).toBe(true)
})
