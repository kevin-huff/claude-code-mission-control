import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { isCloser, isDecider, liveAt, parseLabel, sprintOf } from '../hooks/sprint'
import type { AgentRow, PlanTicket, RunRow, Verdict } from '../types'

const SEC = 1000

type World = { store: D.Store; run: RunRow; rows: AgentRow[]; next: number }

const world = (): World => ({ store: D.createStore(), run: undefined as never, rows: [], next: 1 })

// Starts an agent at `start` seconds; ends it at `end` seconds when given.
const add = (w: World, label: string, start: number, end: number | null = null, reason = 'answer', out = 0): AgentRow => {
  const id = `a${w.next}`
  D.spawned(w.store, { agentId: id, description: label, subagentType: 'workflow-subagent', model: 'claude-opus-5-5', runId: 'wf_s', index: w.next, toolUseId: 'toolu_wf', isTeammate: false }, start * SEC)
  w.next += 1
  if (end !== null) D.turnEnded(w.store, id, reason, end * SEC)
  const row = w.store.agents.get(id) as AgentRow
  row.out = out
  w.run = w.store.runs.get('wf_s') as RunRow
  w.rows = [...w.store.agents.values()]
  return row
}

const tk = (id: string, deps: string[] = [], kind = 'judgment', estimateMin: number | null = null): PlanTicket => ({ id, title: `title ${id}`, kind, dependsOn: deps, estimateMin })
const pass: Verdict = { pass: true, summary: 'ok', issue: '' }
const fail: Verdict = { pass: false, summary: 'no', issue: 'broken' }
const lane = (s: ReturnType<typeof sprintOf>, id: string) => {
  const l = s?.lanes.find(x => x.id === id)
  if (!l) throw new Error(`no lane ${id}`)
  return l
}

test('labels parse in both formats, and deciders and closers are never tickets', () => {
  expect(parseLabel('T1 build 2/3 (sonnet·high)')).toEqual({ id: "T1", role: 'build', n: 2, of: 3, tier: 'sonnet·high' })
  expect(parseLabel('T4 review 1/3 (top·high)')).toEqual({ id: 'T4', role: 'review', n: 1, of: 3, tier: 'top·high' })
  expect(parseLabel("T2' build (haiku·low)")).toEqual({ id: "T2'", role: 'build', n: null, of: null, tier: 'haiku·low' })
  expect(parseLabel('final review (top·max)')).toBe(null)
  expect(parseLabel('integrate (top·high)')).toBe(null)
  expect(parseLabel('plan (top·max)')).toBe(null)
  expect(parseLabel('plan critic (top·high)')).toBe(null)
  expect(parseLabel('something else')).toBe(null)
  expect(isDecider('plan (top·max)')).toBe(true)
  expect(isDecider('plan critic (top·high)')).toBe(true)
  expect(isDecider('T1 build (x)')).toBe(false)
  expect(isCloser('integrate (top·high)')).toBe(true)
  expect(isCloser('final review (top·max)')).toBe(true)
  expect(isCloser('T1 review (x)')).toBe(false)
})

test('liveAt is true from the start up to, not including, the end', () => {
  const w = world()
  const row = add(w, 'T1 build 1/3 (sonnet·high)', 10, 20)
  expect(liveAt(row, 9 * SEC)).toBe(false)
  expect(liveAt(row, 10 * SEC)).toBe(true)
  expect(liveAt(row, 19 * SEC)).toBe(true)
  expect(liveAt(row, 20 * SEC)).toBe(false)
})

function fourTickets(): World {
  const w = world()
  add(w, 'plan (top·max)', 0, 50)
  add(w, 'T1 build 1/3 (sonnet·high)', 60, 100, 'answer', 500)
  const r1 = add(w, 'T1 review 1/3 (top·high)', 100, 130)
  add(w, 'T2 build 1/3 (sonnet·high)', 60, null, 'answer', 700)
  w.run.plan = [tk('T1'), tk('T2'), tk('T3', ['T2']), tk('T4', ['T1'], 'hard', 12)]
  w.run.planFrom = 'planner'
  w.run.verdicts[r1.id] = pass
  return w
}

test('a four-ticket plan: T1 passed, T2 building, T3 waiting, T4 ready', () => {
  const w = fourTickets()
  const s = sprintOf(w.run, w.rows, 150 * SEC)
  if (!s) throw new Error('not a sprint')
  expect(s.stage).toBe('building')
  expect(s.draft).toBe(false)
  expect(s.deciders.length).toBe(1)
  expect(s.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'T3', 'T4'])
  expect(lane(s, 'T1').status).toBe('passed')
  expect(lane(s, 'T1').endedAt).toBe(130 * SEC)
  expect(lane(s, 'T1').startedAt).toBe(60 * SEC)
  expect(lane(s, 'T1').tokens).toBe(500)
  expect(lane(s, 'T2').status).toBe('building')
  expect(lane(s, 'T2').live?.label).toBe('T2 build 1/3 (sonnet·high)')
  expect(lane(s, 'T2').estimateMin).toBe(6)
  expect(lane(s, 'T3').status).toBe('waiting')
  expect(lane(s, 'T4').status).toBe('ready')
  expect(lane(s, 'T4').estimateMin).toBe(12)
  expect(lane(s, 'T3').title).toBe('title T3')
  expect(lane(s, 'T1').maxAttempts).toBe(3)
  expect(s.final).toBe(null)
})

test('the same rows read earlier: T1 is reviewing and has no verdict yet', () => {
  const w = fourTickets()
  const s = sprintOf(w.run, w.rows, 110 * SEC)
  expect(lane(s, 'T1').status).toBe('reviewing')
  expect(lane(s, 'T1').attempts[0]?.verdict).toBe(null)
  expect(lane(s, 'T1').endedAt).toBe(null)
  expect(lane(s, 'T4').status).toBe('waiting')
  const early = sprintOf(w.run, w.rows, 70 * SEC)
  expect(lane(early, 'T1').status).toBe('building')
  expect(lane(early, 'T1').attempts[0]?.review).toBe(null)
})

test('a retry: attempt 1 failed its review, attempt 2 is building at a higher rung', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·medium)', 20, 60)
  const r1 = add(w, 'T1 review 1/3 (sonnet·high)', 60, 80)
  add(w, 'T1 build 2/3 (sonnet·high)', 80)
  w.run.plan = [tk('T1'), tk('T2', ['T1'])]
  w.run.planFrom = 'planner'
  w.run.verdicts[r1.id] = fail
  const s = sprintOf(w.run, w.rows, 100 * SEC)
  const l = lane(s, 'T1')
  expect(l.status).toBe('building')
  expect(l.attempts.length).toBe(2)
  expect(l.attempts.map(a => a.n)).toEqual([1, 2])
  expect(l.attempts.map(a => a.rung)).toEqual([1, 2])
  expect(l.attempts[0]?.verdict).toEqual(fail)
  expect(l.attempts[1]?.review).toBe(null)
  expect(lane(s, 'T2').status).toBe('waiting')
})

test('a retry that has not started yet reads as building', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·medium)', 20, 60)
  const r1 = add(w, 'T1 review 1/3 (sonnet·high)', 60, 80)
  w.run.plan = [tk('T1')]
  w.run.planFrom = 'planner'
  w.run.verdicts[r1.id] = fail
  expect(lane(sprintOf(w.run, w.rows, 90 * SEC), 'T1').status).toBe('building')
})

test('a lane that fails its third review is failed and its dependent is skipped', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  for (let n = 1; n <= 3; n++) {
    add(w, `T1 build ${n}/3 (sonnet·high)`, 20 + n * 100, 60 + n * 100)
    const r = add(w, `T1 review ${n}/3 (top·high)`, 60 + n * 100, 100 + n * 100)
    w.run.verdicts[r.id] = fail
  }
  w.run.plan = [tk('T1'), tk('T2', ['T1']), tk('T3', ['T2'])]
  w.run.planFrom = 'planner'
  const s = sprintOf(w.run, w.rows, 500 * SEC)
  expect(lane(s, 'T1').status).toBe('failed')
  expect(lane(s, 'T1').endedAt).toBe(400 * SEC)
  expect(lane(s, 'T1').attempts.length).toBe(3)
  expect(lane(s, 'T2').status).toBe('skipped')
  expect(lane(s, 'T3').status).toBe('skipped')
  const mid = sprintOf(w.run, w.rows, 380 * SEC)
  expect(lane(mid, 'T1').status).toBe('reviewing')
})

test('a failed review with no verdict and a non-done outcome still counts toward failing', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  for (let n = 1; n <= 3; n++) {
    add(w, `T1 build ${n}/3 (sonnet·high)`, 20 + n * 100, 60 + n * 100)
    add(w, `T1 review ${n}/3 (top·high)`, 60 + n * 100, 100 + n * 100, n === 3 ? 'error' : 'answer')
  }
  w.run.plan = [tk('T1')]
  w.run.planFrom = 'planner'
  expect(lane(sprintOf(w.run, w.rows, 500 * SEC), 'T1').status).toBe('failed')
})

test('when a closer starts, unfinished lanes with attempts fail and untouched lanes are skipped', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·high)', 20, 60)
  add(w, 'integrate (top·high)', 100)
  w.run.plan = [tk('T1'), tk('T2')]
  w.run.planFrom = 'planner'
  const s = sprintOf(w.run, w.rows, 110 * SEC)
  expect(s?.stage).toBe('integrating')
  expect(lane(s, 'T1').status).toBe('failed')
  expect(lane(s, 'T2').status).toBe('skipped')
  expect(s?.closers.length).toBe(1)
})

test('stage moves through reviewing and done, and the final verdict shows only when done', () => {
  const w = fourTickets()
  add(w, 'integrate (top·high)', 200, 260)
  const fin = add(w, 'final review (top·max)', 300)
  w.run.final = { verdict: 'ship', summary: 'good' }
  expect(sprintOf(w.run, w.rows, 270 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 310 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 310 * SEC)?.final).toBe(null)
  D.turnEnded(w.store, fin.id, 'answer', 400 * SEC)
  const done = sprintOf(w.run, w.rows, 410 * SEC)
  expect(done?.stage).toBe('done')
  expect(done?.final).toEqual({ verdict: 'ship', summary: 'good' })
  w.run.endedAt = 420 * SEC
  expect(sprintOf(w.run, w.rows, 415 * SEC)?.endedAt).toBe(null)
  expect(sprintOf(w.run, w.rows, 425 * SEC)?.endedAt).toBe(420 * SEC)
})

test('a draft while the critic runs: stage deciding, draft true, the planner plan in use', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 100)
  add(w, 'plan critic (top·high)', 100)
  w.run.plan = [tk('T1'), tk('T2', ['T1'])]
  w.run.planFrom = 'planner'
  const s = sprintOf(w.run, w.rows, 150 * SEC)
  expect(s?.stage).toBe('deciding')
  expect(s?.draft).toBe(true)
  expect(s?.deciders.length).toBe(2)
  expect(s?.lanes.map(l => l.id)).toEqual(['T1', 'T2'])
  expect(lane(s, 'T1').status).toBe('ready')
})

test('a critic plan is not used until the critic has finished', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 100)
  add(w, 'plan critic (top·high)', 100, 200)
  w.run.plan = [tk('T1'), tk('T2', ['T1'])]
  w.run.planFrom = 'critic'
  const before = sprintOf(w.run, w.rows, 150 * SEC)
  expect(before?.lanes.length).toBe(0)
  expect(before?.stage).toBe('deciding')
  const after = sprintOf(w.run, w.rows, 250 * SEC)
  expect(after?.lanes.length).toBe(2)
  expect(after?.stage).toBe('building')
})

test('an old run with labels and no plan: lanes come from the labels, three attempts at most', () => {
  const w = world()
  add(w, 'T1 build (sonnet·high)', 0, 50)
  add(w, 'T1 review (top·high)', 50, 70)
  add(w, 'T2 build (sonnet·high)', 50, 90)
  add(w, 'T2 review (top·high)', 90, 110)
  add(w, 'T3 build (haiku·low)', 110)
  const [, r1, , r2] = w.rows
  w.run.verdicts[(r1 as AgentRow).id] = pass
  w.run.verdicts[(r2 as AgentRow).id] = fail
  const s = sprintOf(w.run, w.rows, 120 * SEC)
  if (!s) throw new Error('not a sprint')
  expect(s.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'T3'])
  expect(s.lanes.every(l => l.maxAttempts === 3)).toBe(true)
  expect(s.lanes.every(l => l.kind === 'judgment' && l.title === l.id && l.estimateMin === 6)).toBe(true)
  expect(lane(s, 'T1').status).toBe('passed')
  expect(lane(s, 'T2').status).toBe('building')
  expect(lane(s, 'T3').status).toBe('building')
  expect(lane(s, 'T3').attempts[0]?.n).toBe(1)
  expect(lane(s, 'T2').attempts[0]?.verdict).toEqual(fail)
  expect(s.stage).toBe('building')
})

test('ids found only in labels follow the plan tickets, and maxAttempts reads the label', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'X9 build 1/2 (sonnet·high)', 20)
  w.run.plan = [tk('T1', [], 'hard'), tk('T2', ['T2', 'ghost'], 'mechanical')]
  w.run.planFrom = 'planner'
  const s = sprintOf(w.run, w.rows, 30 * SEC)
  expect(s?.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'X9'])
  expect(lane(s, 'T1').estimateMin).toBe(9)
  expect(lane(s, 'T2').estimateMin).toBe(3)
  expect(lane(s, 'T2').status).toBe('ready')
  expect(lane(s, 'X9').maxAttempts).toBe(2)
})

test('a dependency cycle reads as waiting', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  w.run.plan = [tk('A', ['B']), tk('B', ['A']), tk('C')]
  w.run.planFrom = 'planner'
  const s = sprintOf(w.run, w.rows, 30 * SEC)
  expect(lane(s, 'A').status).toBe('waiting')
  expect(lane(s, 'B').status).toBe('waiting')
  expect(lane(s, 'C').status).toBe('ready')
})

test('a review with no build creates an attempt without a build', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 review 2/3 (top·high)', 20)
  w.run.plan = [tk('T1')]
  w.run.planFrom = 'planner'
  const l = lane(sprintOf(w.run, w.rows, 30 * SEC), 'T1')
  expect(l.attempts[0]?.build).toBe(null)
  expect(l.attempts[0]?.n).toBe(2)
  expect(l.attempts[0]?.rung).toBe(3)
  expect(l.status).toBe('reviewing')
})

test('a workflow run that is not a sprint gives null', () => {
  const w = world()
  add(w, 'scan the repo', 0, 10)
  add(w, 'summarise findings', 10)
  expect(sprintOf(w.run, w.rows, 20 * SEC)).toBe(null)
})

test('sprintOf does not change its inputs', () => {
  const w = fourTickets()
  add(w, 'integrate (top·high)', 200)
  const before = JSON.stringify({ run: w.run, rows: w.rows })
  for (const at of [0, 70 * SEC, 110 * SEC, 150 * SEC, 250 * SEC]) sprintOf(w.run, w.rows, at)
  expect(JSON.stringify({ run: w.run, rows: w.rows })).toBe(before)
})

const fixTk = (id: string, from: string, deps: string[] = [], dropped = false): PlanTicket => ({ ...tk(id, deps), from, ...(dropped ? { dropped: true } : {}) })

function fixRound(): World & { fixPlan: AgentRow } {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·high)', 20, 60)
  const r1 = add(w, 'T1 review 1/3 (top·high)', 60, 80)
  add(w, 'T2 build 1/1 (sonnet·high)', 20, 60)
  const r2 = add(w, 'T2 review 1/1 (top·high)', 60, 80)
  add(w, 'integrate (top·high)', 100, 150)
  add(w, 'final review (top·max)', 150, 200)
  const fixPlan = add(w, 'fix plan (top·high)', 210, 260)
  w.run.verdicts[r1.id] = pass
  w.run.verdicts[r2.id] = fail
  w.run.plan = [tk('T1'), tk('T2'), fixTk('F1', fixPlan.id), fixTk('F2', fixPlan.id, ['F1'])]
  w.run.planFrom = 'planner'
  w.run.final = { verdict: 'fix first', summary: 'two seams open' }
  return { ...w, fixPlan }
}

test('a fix round: deciding while the fix plan runs, its tickets appear once it ends', () => {
  const w = fixRound()
  const before = sprintOf(w.run, w.rows, 190 * SEC)
  expect(before?.round).toBe(0)
  expect(before?.stage).toBe('reviewing')
  const live = sprintOf(w.run, w.rows, 230 * SEC)
  if (!live) throw new Error('not a sprint')
  expect(isDecider('fix plan (top·high)')).toBe(true)
  expect(parseLabel('fix plan (top·high)')).toBe(null)
  expect(live.round).toBe(1)
  expect(live.stage).toBe('deciding')
  expect(live.final).toBe(null)
  expect(live.closers.length).toBe(0)
  expect(live.deciders.map(r => r.label)).toEqual(['plan (top·max)', 'fix plan (top·high)'])
  expect(live.lanes.map(l => l.id)).toEqual(['T1', 'T2'])
  expect(lane(live, 'T1').status).toBe('passed')
  expect(lane(live, 'T2').status).toBe('failed')
  const planned = sprintOf(w.run, w.rows, 265 * SEC)
  expect(planned?.stage).toBe('deciding')
  expect(planned?.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'F1', 'F2'])
  expect(lane(planned, 'F1').status).toBe('ready')
  expect(lane(planned, 'F2').status).toBe('waiting')
})

test('a fix round builds, integrates, reviews and ends on the latest final verdict', () => {
  const w = fixRound()
  add(w, 'F1 build 1/3 (sonnet·high)', 270, 320)
  const f1r = add(w, 'F1 review 1/3 (top·high)', 320, 340)
  add(w, 'F2 build 1/3 (sonnet·high)', 340, 346)
  const f2r = add(w, 'F2 review 1/3 (top·high)', 346, 349)
  w.run.verdicts[f1r.id] = pass
  w.run.verdicts[f2r.id] = pass
  const building = sprintOf(w.run, w.rows, 300 * SEC)
  expect(building?.stage).toBe('building')
  expect(building?.round).toBe(1)
  expect(lane(building, 'F1').status).toBe('building')
  expect(lane(building, 'F2').status).toBe('waiting')
  expect(lane(building, 'T2').status).toBe('failed')
  expect(lane(sprintOf(w.run, w.rows, 342 * SEC), 'F2').status).toBe('building')
  add(w, 'integrate (top·high)', 350, 400)
  const fin = add(w, 'final review (top·max)', 410)
  const integrating = sprintOf(w.run, w.rows, 360 * SEC)
  expect(integrating?.stage).toBe('integrating')
  expect(integrating?.closers.map(r => r.startedAt)).toEqual([350 * SEC])
  expect(lane(integrating, 'F1').status).toBe('passed')
  expect(lane(integrating, 'F2').status).toBe('passed')
  expect(sprintOf(w.run, w.rows, 405 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 420 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 420 * SEC)?.final).toBe(null)
  D.turnEnded(w.store, fin.id, 'answer', 460 * SEC)
  w.run.final = { verdict: 'ship', summary: 'fixed' }
  const done = sprintOf(w.run, w.rows, 470 * SEC)
  expect(done?.stage).toBe('done')
  expect(done?.round).toBe(1)
  expect(done?.final).toEqual({ verdict: 'ship', summary: 'fixed' })
  expect(done?.closers.length).toBe(2)
})

test('a fix ticket left untouched when its own round closes is skipped, not before', () => {
  const w = fixRound()
  add(w, 'F1 build 1/3 (sonnet·high)', 270)
  add(w, 'integrate (top·high)', 400)
  const s = sprintOf(w.run, w.rows, 300 * SEC)
  expect(lane(s, 'F1').status).toBe('building')
  expect(lane(s, 'F2').status).toBe('waiting')
  const late = sprintOf(w.run, w.rows, 410 * SEC)
  expect(lane(late, 'F2').status).toBe('skipped')
})

test('issues mode: a fix plan before any closer is round 0 and its tickets wait for it to end', () => {
  const w = world()
  const fp = add(w, 'fix plan (top·high)', 0, 50)
  w.run.plan = [fixTk('F1', fp.id), fixTk('F2', fp.id, ['F1'])]
  w.run.planFrom = 'planner'
  const early = sprintOf(w.run, w.rows, 20 * SEC)
  expect(early?.round).toBe(0)
  expect(early?.stage).toBe('deciding')
  expect(early?.lanes.length).toBe(0)
  const after = sprintOf(w.run, w.rows, 60 * SEC)
  expect(after?.round).toBe(0)
  expect(after?.stage).toBe('building')
  expect(after?.lanes.map(l => l.id)).toEqual(['F1', 'F2'])
})

test('dropped tickets are never lanes, and tickets that need one are skipped', () => {
  const w = fixRound()
  w.run.plan = [
    tk('T1'),
    tk('T2'),
    { ...tk('T3'), dropped: true },
    tk('T4', ['T3']),
    fixTk('F1', w.fixPlan.id),
    fixTk('F2', w.fixPlan.id, [], true),
    fixTk('F3', w.fixPlan.id, ['F2']),
  ]
  add(w, 'T3 build 1/3 (sonnet·high)', 20, 30)
  const first = sprintOf(w.run, w.rows, 30 * SEC)
  expect(first?.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'T4'])
  expect(lane(first, 'T4').status).toBe('skipped')
  const fix = sprintOf(w.run, w.rows, 265 * SEC)
  expect(fix?.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'T4', 'F1', 'F3'])
  expect(lane(fix, 'F1').status).toBe('ready')
  expect(lane(fix, 'F3').status).toBe('skipped')
})

test('in replay a lane counts only the tokens written by the cursor', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·high)', 20, 60, 'answer', 400)
  add(w, 'T1 review 1/3 (top·high)', 60, 100, 'answer', 200)
  add(w, 'T2 build 1/3 (sonnet·high)', 20, null, 'answer', 300)
  w.run.plan = [tk('T1'), tk('T2')]
  w.run.planFrom = 'planner'
  expect(lane(sprintOf(w.run, w.rows, 40 * SEC), 'T1').tokens).toBe(200)
  expect(lane(sprintOf(w.run, w.rows, 80 * SEC), 'T1').tokens).toBe(500)
  expect(lane(sprintOf(w.run, w.rows, 120 * SEC), 'T1').tokens).toBe(600)
  expect(lane(sprintOf(w.run, w.rows, 40 * SEC), 'T2').tokens).toBe(300)
})

function reviewedBy(verdicts: string[]): World & { reviews: AgentRow[] } {
  const w = fourTickets()
  add(w, 'integrate (top·high)', 200, 260)
  const reviews = verdicts.map((_, i) => add(w, 'final review (top·max)', 300 + i))
  verdicts.forEach((v, i) => { w.run.finals[(reviews[i] as AgentRow).id] = { verdict: v, summary: `says ${v} ${i}` } })
  return { ...w, reviews }
}

test('three final reviewers: the stage stays reviewing until the last one ends', () => {
  const w = reviewedBy(['ship', 'ship', 'ship'])
  const [a, b, c] = w.reviews as [AgentRow, AgentRow, AgentRow]
  D.turnEnded(w.store, a.id, 'answer', 350 * SEC)
  expect(sprintOf(w.run, w.rows, 340 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 360 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 360 * SEC)?.final).toBe(null)
  D.turnEnded(w.store, c.id, 'answer', 380 * SEC)
  expect(sprintOf(w.run, w.rows, 390 * SEC)?.stage).toBe('reviewing')
  D.turnEnded(w.store, b.id, 'answer', 400 * SEC)
  expect(sprintOf(w.run, w.rows, 390 * SEC)?.stage).toBe('reviewing')
  expect(sprintOf(w.run, w.rows, 410 * SEC)?.stage).toBe('done')
  expect(sprintOf(w.run, w.rows, 410 * SEC)?.final?.verdict).toBe('ship')
})

test('final verdicts ship, fix first and ship merge to fix first, with the worst one summary', () => {
  const w = reviewedBy(['ship', 'fix first', 'ship'])
  for (const r of w.reviews) D.turnEnded(w.store, r.id, 'answer', 400 * SEC)
  expect(sprintOf(w.run, w.rows, 410 * SEC)?.final).toEqual({ verdict: 'fix first', summary: 'says fix first 1' })
})

test('block beats fix first, and a reviewer that gave no verdict does not count', () => {
  const w = reviewedBy(['fix first', 'block', 'ship'])
  for (const r of w.reviews) D.turnEnded(w.store, r.id, 'answer', 400 * SEC)
  expect(sprintOf(w.run, w.rows, 410 * SEC)?.final?.verdict).toBe('block')
  delete w.run.finals[(w.reviews[1] as AgentRow).id]
  expect(sprintOf(w.run, w.rows, 410 * SEC)?.final?.verdict).toBe('fix first')
})

test('in a fix round, previous is the first round merged verdict and round 0 has none', () => {
  const w = world()
  add(w, 'plan (top·max)', 0, 10)
  add(w, 'T1 build 1/3 (sonnet·high)', 20, 60)
  const r1 = add(w, 'T1 review 1/3 (top·high)', 60, 80)
  add(w, 'integrate (top·high)', 100, 150)
  const f1 = add(w, 'final review (top·max)', 150, 200)
  const f2 = add(w, 'final review (top·max)', 150, 190)
  const fixPlan = add(w, 'fix plan (top·high)', 210, 260)
  add(w, 'F1 build 1/3 (sonnet·high)', 270, 320)
  add(w, 'integrate (top·high)', 330, 360)
  const g1 = add(w, 'final review (top·max)', 370, 400)
  w.run.verdicts[r1.id] = pass
  w.run.plan = [tk('T1'), fixTk('F1', fixPlan.id)]
  w.run.planFrom = 'planner'
  w.run.finals[f1.id] = { verdict: 'ship', summary: 'fine' }
  w.run.finals[f2.id] = { verdict: 'fix first', summary: 'seam open' }
  w.run.finals[g1.id] = { verdict: 'ship', summary: 'fixed' }
  const first = sprintOf(w.run, w.rows, 205 * SEC)
  expect(first?.round).toBe(0)
  expect(first?.previous).toBe(null)
  expect(first?.final).toEqual({ verdict: 'fix first', summary: 'seam open' })
  const second = sprintOf(w.run, w.rows, 410 * SEC)
  expect(second?.round).toBe(1)
  expect(second?.stage).toBe('done')
  expect(second?.previous).toEqual({ verdict: 'fix first', summary: 'seam open' })
  expect(second?.final).toEqual({ verdict: 'ship', summary: 'fixed' })
  expect(sprintOf(w.run, w.rows, 300 * SEC)?.previous).toEqual({ verdict: 'fix first', summary: 'seam open' })
})
