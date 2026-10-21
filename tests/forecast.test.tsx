import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { FINAL_MIN, INTEGRATE_MIN, forecast } from '../hooks/forecast'
import type { AgentRow, Forecast, Lane, LaneStatus, Projection, Sprint } from '../types'

const MIN = 60000

const pj = (f: Forecast, id: string): Projection => f.projections[id]!

const lane = (id: string, estimateMin: number, status: LaneStatus, dependsOn: string[] = [], more: Partial<Lane> = {}): Lane => ({
  id,
  title: `ticket ${id}`,
  kind: 'routine',
  dependsOn,
  estimateMin,
  status,
  attempts: [],
  maxAttempts: 3,
  startedAt: null,
  endedAt: null,
  tokens: 0,
  live: null,
  ...more,
})

const sprint = (lanes: Lane[], more: Partial<Sprint> = {}): Sprint => ({
  tokens: 0,
  previous: null,
  runId: 'wf_r',
  name: 'sprint',
  startedAt: 0,
  endedAt: null,
  at: 0,
  round: 0,
  stage: 'building',
  draft: false,
  lanes,
  deciders: [],
  closers: [],
  final: null,
  ...more,
})

function row(store: D.Store, id: string, label: string, start: number, end: number | null): AgentRow {
  D.spawned(store, {
    agentId: id,
    description: label,
    subagentType: 'workflow-subagent',
    model: 'claude-opus-5-5',
    runId: 'wf_r',
    index: store.agents.size,
    toolUseId: 'toolu_wf',
    isTeammate: false,
  }, start)
  if (end !== null) D.turnEnded(store, id, 'answer', end)
  return store.agents.get(id)!
}

const chain = (): Lane[] => [
  lane('T1', 4, 'ready'),
  lane('T2', 4, 'waiting', ['T1']),
  lane('T3', 4, 'waiting', ['T2']),
  lane('T4', 2, 'ready'),
]

test('a three-ticket chain is the critical path and sets the finish estimate', () => {
  const f = forecast(sprint(chain()), 0)
  expect(f.at).toBe(0)
  expect(f.factor).toBe(1)
  expect(pj(f, 'T3').finish).toBe(12 * MIN)
  expect(f.buildEnd).toBe(12 * MIN)
  expect(f.criticalPath).toEqual(['T1', 'T2', 'T3'])
  expect(pj(f, 'T1').critical).toBe(true)
  expect(pj(f, 'T4').critical).toBe(false)
  expect(pj(f, 'T4').slackMs).toBe(10 * MIN)
  expect(pj(f, 'T2').slackMs).toBe(0)
  expect(pj(f, 'T2').after).toBe('T1')
  expect(pj(f, 'T4').after).toBe(null)
  expect(f.eta).toBe(42 * MIN)
  expect(f.longPole).toBe('T1')
  expect(INTEGRATE_MIN + FINAL_MIN).toBe(30)
})

test('a passed ticket that took twice its estimate stretches the rest', () => {
  const lanes = [
    lane('T1', 4, 'passed', [], { startedAt: 0, endedAt: 8 * MIN }),
    lane('T2', 4, 'ready', ['T1']),
  ]
  const f = forecast(sprint(lanes), 8 * MIN)
  expect(f.factor > 1).toBe(true)
  expect(pj(f, 'T1').finish).toBe(8 * MIN)
  expect(pj(f, 'T2').start).toBe(8 * MIN)
  expect(pj(f, 'T2').finish > 12 * MIN).toBe(true)
  expect(pj(f, 'T2').finish).toBe(8 * MIN + 4 * MIN * f.factor)
})

test('the factor stays between one half and three', () => {
  const slow = forecast(sprint([lane('T1', 1, 'passed', [], { startedAt: 0, endedAt: 100 * MIN }), lane('T2', 1, 'ready')]), 100 * MIN)
  expect(slow.factor).toBe(3)
  const fast = (id: string) => lane(id, 10, 'passed', [], { startedAt: 0, endedAt: 1000 })
  const quick = forecast(sprint([fast('T1'), fast('T2'), fast('T3'), fast('T4')]), 1000)
  expect(quick.factor).toBe(0.5)
})

test('a running ticket past its estimate is still projected to finish after now', () => {
  const store = D.createStore()
  const build = row(store, 'b1', 'T1 build 1/3 (sonnet·high)', 0, null)
  const lanes = [
    lane('T1', 4, 'building', [], {
      startedAt: 0,
      live: build,
      attempts: [{ n: 1, tier: 'sonnet·high', rung: 2, build, review: null, verdict: null }],
    }),
    lane('T2', 4, 'waiting', ['T1']),
  ]
  for (const at of [1 * MIN, 4 * MIN, 9 * MIN, 60 * MIN]) {
    const f = forecast(sprint(lanes), at)
    expect(pj(f, 'T1').finish > at).toBe(true)
    expect(pj(f, 'T2').start >= pj(f, 'T1').finish).toBe(true)
    expect(f.longPole).toBe('T1')
  }
  expect(pj(forecast(sprint(lanes), 1 * MIN), 'T1').finish).toBe(4 * MIN)
  expect(pj(forecast(sprint(lanes), 9 * MIN), 'T1').finish).toBe(9 * MIN + 0.25 * 9 * MIN)
})

test('a failed review with no live agent counts the whole retry', () => {
  const store = D.createStore()
  const build = row(store, 'b1', 'T1 build 1/3 (sonnet·high)', 0, 3 * MIN)
  const review = row(store, 'r1', 'T1 review 1/3 (sonnet·high)', 3 * MIN, 5 * MIN)
  const lanes = [
    lane('T1', 4, 'reviewing', [], {
      startedAt: 0,
      attempts: [{ n: 1, tier: 'sonnet·high', rung: 2, build, review, verdict: { pass: false, summary: 'no', issue: 'broken' } }],
    }),
  ]
  expect(pj(forecast(sprint(lanes), 5 * MIN), 'T1').finish).toBe(9 * MIN)
})

test('tickets waiting behind a building ticket are grouped under it', () => {
  const store = D.createStore()
  const build = row(store, 'b1', 'T1 build 1/3 (sonnet·high)', 0, null)
  const lanes = [
    lane('T1', 4, 'building', [], { startedAt: 0, live: build, attempts: [{ n: 1, tier: 'sonnet·high', rung: 2, build, review: null, verdict: null }] }),
    lane('T2', 4, 'waiting', ['T1']),
    lane('T3', 4, 'waiting', ['T2']),
    lane('T4', 2, 'passed', [], { startedAt: 0, endedAt: 2 * MIN }),
  ]
  const f = forecast(sprint(lanes), 2 * MIN)
  expect(f.waiting).toEqual([{ on: 'T1', blocked: ['T2', 'T3'] }])
})

test('skipped tickets never sit on the critical path', () => {
  const lanes = [
    lane('T1', 4, 'failed', [], { startedAt: 0, endedAt: 10 * MIN }),
    lane('T2', 20, 'skipped', ['T1']),
    lane('T3', 2, 'ready'),
  ]
  const f = forecast(sprint(lanes), 10 * MIN)
  expect(pj(f, 'T2').critical).toBe(false)
  expect(pj(f, 'T2').finish).toBe(10 * MIN)
  expect(f.criticalPath).toEqual(['T3'])
})

test('a dependency cycle still forecasts every ticket', () => {
  const lanes = [lane('A', 2, 'ready', ['B']), lane('B', 2, 'ready', ['A']), lane('C', 1, 'ready', ['C'])]
  const f = forecast(sprint(lanes), 0)
  expect(Object.keys(f.projections).sort()).toEqual(['A', 'B', 'C'])
  expect(f.buildEnd).toBe(4 * MIN)
})

test('while deciding there is no finish estimate', () => {
  const f = forecast(sprint(chain(), { stage: 'deciding' }), 0)
  expect(f.eta).toBe(null)
  expect(f.buildEnd).toBe(null)
  expect(forecast(sprint([], { stage: 'deciding' }), 0).eta).toBe(null)
})

test('the integrating and done estimates follow the closers', () => {
  const lanes = [lane('T1', 4, 'passed', [], { startedAt: 0, endedAt: 4 * MIN })]
  const store = D.createStore()
  const integrate = row(store, 'i1', 'integrate (top·high)', 4 * MIN, null)
  const live = forecast(sprint(lanes, { stage: 'integrating', closers: [integrate] }), 6 * MIN)
  expect(live.eta).toBe(6 * MIN + 10 * MIN + 18 * MIN)
  const late = forecast(sprint(lanes, { stage: 'integrating', closers: [integrate] }), 20 * MIN)
  expect(late.eta).toBe(20 * MIN + 0.25 * 16 * MIN + 18 * MIN)

  const done = D.createStore()
  const ended = row(done, 'i1', 'integrate (top·high)', 4 * MIN, 9 * MIN)
  const between = forecast(sprint(lanes, { stage: 'integrating', closers: [ended] }), 10 * MIN)
  expect(between.eta).toBe(28 * MIN)
  const final = row(done, 'f1', 'final review (top·high)', 10 * MIN, null)
  expect(forecast(sprint(lanes, { stage: 'reviewing', closers: [ended, final] }), 12 * MIN).eta).toBe(28 * MIN)

  const finished = row(done, 'f2', 'final review (top·high)', 10 * MIN, 17 * MIN)
  expect(forecast(sprint(lanes, { stage: 'done', closers: [ended, finished] }), 30 * MIN).eta).toBe(17 * MIN)
  expect(forecast(sprint(lanes, { stage: 'done', endedAt: 19 * MIN, closers: [ended, finished] }), 30 * MIN).eta).toBe(19 * MIN)
})

test('a sprint where nothing passed skips integrate and final review', () => {
  const lanes = [lane('T1', 4, 'failed', [], { startedAt: 0, endedAt: 5 * MIN }), lane('T2', 4, 'skipped', ['T1'])]
  expect(forecast(sprint(lanes), 6 * MIN).eta).toBe(6 * MIN)
})

test('the same input gives the same forecast and is left unchanged', () => {
  const store = D.createStore()
  const build = row(store, 'b1', 'T2 build 1/3 (sonnet·high)', 4 * MIN, null)
  const lanes = [
    lane('T1', 4, 'passed', [], { startedAt: 0, endedAt: 6 * MIN }),
    lane('T2', 4, 'building', ['T1'], { startedAt: 6 * MIN, live: build, attempts: [{ n: 1, tier: 'sonnet·high', rung: 2, build, review: null, verdict: null }] }),
    lane('T3', 3, 'waiting', ['T2']),
    lane('T4', 2, 'ready', ['T1']),
  ]
  const s = sprint(lanes)
  const before = JSON.stringify(s)
  const a = forecast(s, 7 * MIN)
  const b = forecast(s, 7 * MIN)
  expect(a).toEqual(b)
  expect(JSON.stringify(s)).toBe(before)
})

test('a final review that overruns its estimate keeps its finish moving out', () => {
  const lanes = [lane('T1', 4, 'passed', [], { startedAt: 0, endedAt: 4 * MIN })]
  const store = D.createStore()
  const integrate = row(store, 'i1', 'integrate (top·high)', 4 * MIN, 10 * MIN)
  const final = row(store, 'f1', 'final review (top·max)', 0, null)
  const etaAt = (at: number) => forecast(sprint(lanes, { stage: 'reviewing', closers: [integrate, final] }), at).eta!
  expect(etaAt(25 * MIN) - 25 * MIN).toBeGreaterThanOrEqual(6 * MIN)
  expect(etaAt(30 * MIN)).toBeGreaterThan(etaAt(20 * MIN))
  expect(etaAt(30 * MIN) - 30 * MIN).toBe(7.5 * MIN)
})

test('an integrate that overruns its estimate keeps its finish moving out', () => {
  const lanes = [lane('T1', 4, 'passed', [], { startedAt: 0, endedAt: 4 * MIN })]
  const store = D.createStore()
  const integrate = row(store, 'i1', 'integrate (top·high)', 0, null)
  const etaAt = (at: number) => forecast(sprint(lanes, { stage: 'integrating', closers: [integrate] }), at).eta!
  expect(etaAt(30 * MIN)).toBeGreaterThan(etaAt(20 * MIN))
  expect(etaAt(30 * MIN) - 30 * MIN).toBe(7.5 * MIN + 18 * MIN)
})

test('a ticket estimated at 9 minutes and still running at 31 keeps projecting ahead', () => {
  const store = D.createStore()
  const build = row(store, 'b1', 'T13 build 1/3 (sonnet·high)', 0, null)
  const lanes = [
    lane('T13', 9, 'building', [], {
      startedAt: 0,
      live: build,
      attempts: [{ n: 1, tier: 'sonnet·high', rung: 2, build, review: null, verdict: null }],
    }),
  ]
  const at20 = pj(forecast(sprint(lanes), 20 * MIN), 'T13').finish
  const at31 = pj(forecast(sprint(lanes), 31 * MIN), 'T13').finish
  expect(at31 - 31 * MIN).toBeGreaterThanOrEqual(7 * MIN)
  expect(at31).toBeGreaterThan(at20)
})
