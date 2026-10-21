import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted, TestBody } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { sprintOf } from '../hooks/sprint'
import type { AgentRow, RunRow } from '../types'

type On = Parameters<TestBody>[1]

const SEC = 1000
const RUN = 'wf_fix'
const JOURNAL = `/t/s/subagents/workflows/${RUN}/journal.jsonl`
const line = (o: unknown) => `${JSON.stringify(o)}\n`

type Step = { id: string; label: string; start: number; end: number; result?: unknown }

const ok = { pass: true, summary: 'looks right', issues: [] }
const plan = {
  tickets: [
    { id: 'T1', title: 'First', kind: 'routine', dependsOn: [], estimateMin: 4 },
    { id: 'T2', title: 'Second', kind: 'routine', dependsOn: ['T1'], estimateMin: 4 },
  ],
}
const triage = {
  tickets: [
    { id: 'X1', title: 'Fix the first thing', kind: 'routine', dependsOn: [], estimateMin: 4 },
    { id: 'X2', title: 'Fix the second thing', kind: 'routine', dependsOn: ['X1'], estimateMin: 4 },
  ],
}

// One run with a fix round: the first final review says "fix first", a fix plan renames X1 and X2 to F1 and F2, and the second final review says "ship".
const STEPS: Step[] = [
  { id: 'p1', label: 'plan (top·max)', start: 0, end: 10, result: plan },
  { id: 'c1', label: 'plan critic (top·high)', start: 10, end: 20, result: plan },
  { id: 't1b', label: 'T1 build 1/3 (haiku·low)', start: 20, end: 40 },
  { id: 't1r', label: 'T1 review 1/3 (sonnet·high)', start: 40, end: 50, result: ok },
  { id: 't2b', label: 'T2 build 1/3 (haiku·low)', start: 50, end: 70 },
  { id: 't2r', label: 'T2 review 1/3 (sonnet·high)', start: 70, end: 80, result: ok },
  { id: 'i1', label: 'integrate (sonnet·high)', start: 80, end: 90 },
  { id: 'v1', label: 'final review (top·max)', start: 90, end: 100, result: { verdict: 'fix first', summary: 'two gaps remain' } },
  { id: 'x1', label: 'fix plan (top·high)', start: 100, end: 120, result: triage },
  { id: 'f1b', label: 'F1 build 1/3 (haiku·low)', start: 120, end: 140 },
  { id: 'f1r', label: 'F1 review 1/3 (sonnet·high)', start: 140, end: 150, result: ok },
  { id: 'f2b', label: 'F2 build 1/3 (haiku·low)', start: 150, end: 170 },
  { id: 'f2r', label: 'F2 review 1/3 (sonnet·high)', start: 170, end: 180, result: ok },
  { id: 'i2', label: 'integrate (sonnet·high)', start: 180, end: 190 },
  { id: 'v2', label: 'final review (top·max)', start: 190, end: 200, result: { verdict: 'ship', summary: 'all fixed' } },
]

const started = (s: Step) => line({ type: 'started', agentId: s.id, label: s.label, phase: 'run', key: s.id })
const resulted = (s: Step) => (s.result === undefined ? '' : line({ type: 'result', agentId: s.id, key: s.id, result: s.result }))

function modelAt(through: number) {
  const store = D.createStore()
  let text = line({ type: 'launched' })
  STEPS.forEach((s, i) => {
    D.spawned(store, { agentId: s.id, description: s.label, subagentType: 'workflow-subagent', model: 'm', runId: RUN, index: i, toolUseId: 'toolu_fix', isTeammate: false }, s.start * SEC)
    D.turnEnded(store, s.id, 'answer', s.end * SEC)
    text += started(s) + resulted(s)
  })
  D.absorbJournal(store, RUN, text, through * SEC)
  const run = store.runs.get(RUN) as RunRow
  run.endedAt = 200 * SEC
  const rows = [...store.agents.values()] as AgentRow[]
  return (at: number) => {
    const s = sprintOf(run, rows, at * SEC)
    if (!s) throw new Error('not a sprint')
    return s
  }
}

const status = (s: ReturnType<ReturnType<typeof modelAt>>) => Object.fromEntries(s.lanes.map(l => [l.id, l.status]))

test('the model names the fix tickets F1 and F2 from the fix plan and keeps their order', () => {
  const store = D.createStore()
  STEPS.forEach((s, i) => D.spawned(store, { agentId: s.id, description: s.label, subagentType: 'workflow-subagent', model: 'm', runId: RUN, index: i, toolUseId: 'toolu_fix', isTeammate: false }, s.start * SEC))
  D.absorbJournal(store, RUN, STEPS.map(s => started(s) + resulted(s)).join(''), 1)
  const p = (store.runs.get(RUN) as RunRow).plan ?? []
  expect(p.map(t => t.id)).toEqual(['T1', 'T2', 'F1', 'F2'])
  expect(p[3]?.dependsOn).toEqual(['F1'])
  expect(p[2]?.from).toBe('x1')
  expect(p[0]?.from).toBeUndefined()
})

test('during the fix plan the stage is deciding, round 1, and only T1 and T2 are lanes', () => {
  const at = modelAt(200)
  const s = at(110)
  expect(s.stage).toBe('deciding')
  expect(s.round).toBe(1)
  expect(s.lanes.map(l => l.id)).toEqual(['T1', 'T2'])
  expect(status(s)).toEqual({ T1: 'passed', T2: 'passed' })
  expect(s.closers.length).toBe(0)
  expect(s.deciders.map(r => r.label)).toEqual(['plan (top·max)', 'plan critic (top·high)', 'fix plan (top·high)'])
  expect(s.final).toBe(null)
})

test('while F1 builds the stage is building, F2 waits, and nothing is skipped', () => {
  const at = modelAt(200)
  const s = at(130)
  expect(s.stage).toBe('building')
  expect(s.round).toBe(1)
  expect(s.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'F1', 'F2'])
  expect(status(s)).toEqual({ T1: 'passed', T2: 'passed', F1: 'building', F2: 'waiting' })
  expect(s.lanes.find(l => l.id === 'F1')?.title).toBe('Fix the first thing')
  expect(s.lanes.find(l => l.id === 'F2')?.dependsOn).toEqual(['F1'])
  expect(s.closers.length).toBe(0)
  expect(s.final).toBe(null)
})

test('once F1 passes, F2 starts and nothing is skipped', () => {
  const s = modelAt(200)(150)
  expect(s.stage).toBe('building')
  expect(status(s)).toEqual({ T1: 'passed', T2: 'passed', F1: 'passed', F2: 'building' })
})

test('at the end the stage is done, the final verdict is the second review, and all four lanes passed', () => {
  const at = modelAt(200)
  const s = at(201)
  expect(s.stage).toBe('done')
  expect(s.round).toBe(1)
  expect(s.final).toEqual({ verdict: 'ship', summary: 'all fixed' })
  expect(s.lanes.length).toBe(4)
  expect(status(s)).toEqual({ T1: 'passed', T2: 'passed', F1: 'passed', F2: 'passed' })
  expect(s.closers.map(r => r.id)).toEqual(['i2', 'v2'])
})

test('the second integrate puts the stage into integrating, then reviewing', () => {
  const at = modelAt(200)
  expect(at(185).stage).toBe('integrating')
  expect(at(195).stage).toBe('reviewing')
})

test('the first round still reads as it did before the fix plan', () => {
  const at = modelAt(200)
  const s = at(85)
  expect(s.round).toBe(0)
  expect(s.stage).toBe('integrating')
  expect(s.lanes.map(l => l.id)).toEqual(['T1', 'T2'])
})

const PANE = (surface: 'terminal' | 'desktop', bodyColumns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: { title: 'Mission Control', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }) as const

const spawnInput = (description: string, index: number) => ({
  tool_use_id: 'toolu_wf',
  prompt: 'do it',
  description,
  subagentType: 'workflow-subagent',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  workflow: { runId: RUN, agentIndex: index },
})

// Plays the steps live: each agent is spawned, runs for its stretch of the clock, and hands its result to the journal.
async function play($: Engine, on: On, through: number, hold: boolean) {
  const clock = mock.clock(on, { now: 1_000_000 })
  let journal = line({ type: 'launched' })
  let spawnId = ''
  on('session.id', () => ({ value: 's' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: journal }
  })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: spawnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  for (let i = 0; i <= through; i++) {
    const s = STEPS[i] as Step
    spawnId = s.id
    await $.agent.spawn(spawnInput(s.label, i + 1))
    journal += started(s)
    if (i === through && hold) {
      await clock.advance(6_000)
      break
    }
    await clock.advance(5_000)
    await $.turn.complete({ agentId: s.id, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: `t${i}` })
    journal += resulted(s)
    await clock.advance(4_000)
  }
}

const WIDTHS = [60, 84, 110]
const SURFACES = ['terminal', 'desktop'] as const

async function eachPane($: Engine, check: (ui: Mounted<'terminal' | 'desktop', 'Pane'>, where: string) => Promise<void>) {
  for (const surface of SURFACES) {
    for (const width of WIDTHS) {
      const ui = await $.ui.mount(PANE(surface, width))
      await check(ui, `${surface} ${width}`)
      await ui.unmount()
    }
  }
}

test('panes show Planning fixes and a fix plan decider while the fix plan runs, with no skipped lanes', async ($, on) => {
  await play($, on, 8, true)
  await eachPane($, async (ui, where) => {
    expect(await ui.find({ text: /Planning fixes/ }), `${where}: headline`).toBeDefined()
    expect(await ui.find({ text: /fix plan/ }), `${where}: decider`).toBeDefined()
    expect(await ui.find({ text: /skipped/ }), `${where}: skipped`).toBeUndefined()
  })
})

test('panes show the F lanes while F1 builds, with no skipped lanes', async ($, on) => {
  await play($, on, 9, true)
  await eachPane($, async (ui, where) => {
    expect(await ui.find({ text: /fix plan/ }), `${where}: decider`).toBeDefined()
    expect(await ui.find({ text: /F1/ }), `${where}: F1`).toBeDefined()
    expect(await ui.find({ text: /F2/ }), `${where}: F2`).toBeDefined()
    expect(await ui.find({ text: /Planning fixes/ }), `${where}: headline`).toBeUndefined()
    expect(await ui.find({ text: /skipped/ }), `${where}: skipped`).toBeUndefined()
  })
})

test('panes show final review: ship, the F lanes and the fix plan at the end', async ($, on) => {
  await play($, on, STEPS.length - 1, false)
  await eachPane($, async (ui, where) => {
    expect(await ui.find({ text: /Final review: ship/ }), `${where}: verdict`).toBeDefined()
    expect(await ui.find({ text: /fix plan/ }), `${where}: decider`).toBeDefined()
    expect(await ui.find({ text: /F1/ }), `${where}: F1`).toBeDefined()
    expect(await ui.find({ text: /F2/ }), `${where}: F2`).toBeDefined()
    expect(await ui.find({ text: /skipped/ }), `${where}: skipped`).toBeUndefined()
  })
})
