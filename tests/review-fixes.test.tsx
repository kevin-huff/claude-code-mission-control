import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { forecast } from '../hooks/forecast'
import { headline } from '../hooks/headline'
import { sprintOf } from '../hooks/sprint'
import type { AgentRow, RunRow } from '../types'

const SEC = 1000
const RUN = 'wf_rf'
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const ok = { pass: true, summary: 'fine', issues: [] }

type Step = { id: string; label: string; start: number; end: number; outcome?: 'answer' | 'error'; result?: unknown }

const plan = {
  tickets: [
    { id: 'T1', title: 'First', kind: 'routine', dependsOn: [], estimateMin: 2 },
    { id: 'T2', title: 'Second', kind: 'routine', dependsOn: ['T1'], estimateMin: 2 },
    { id: 'T3', title: 'Third', kind: 'routine', dependsOn: ['T2'], estimateMin: 2 },
  ],
}
const triage = { tickets: [{ id: 'X1', title: 'Small fix', kind: 'mechanical', dependsOn: [], estimateMin: 1 }] }

// The first round's T1 → T2 → T3 is the sprint's long pole (120 s); the fix round's lone F1 (10 s) finishes
// last. The first final review ends at 160 and the fix plan starts at 170, so 165 sits between the rounds.
function steps(second: Partial<Step> = {}): Step[] {
  return [
    { id: 'p1', label: 'plan (top·max)', start: 0, end: 10, result: plan },
    { id: 'c1', label: 'plan critic (top·high)', start: 10, end: 20, result: plan },
    { id: 't1b', label: 'T1 build 1/3 (sonnet·medium)', start: 20, end: 50 },
    { id: 't1r', label: 'T1 review 1/3 (sonnet·high)', start: 50, end: 60, result: ok },
    { id: 't2b', label: 'T2 build 1/3 (sonnet·medium)', start: 60, end: 90 },
    { id: 't2r', label: 'T2 review 1/3 (sonnet·high)', start: 90, end: 100, result: ok },
    { id: 't3b', label: 'T3 build 1/3 (sonnet·medium)', start: 100, end: 130 },
    { id: 't3r', label: 'T3 review 1/3 (sonnet·high)', start: 130, end: 140, result: ok },
    { id: 'i1', label: 'integrate (top·high)', start: 140, end: 150 },
    { id: 'v1', label: 'final review (top·max)', start: 150, end: 160, result: { verdict: 'fix first', summary: 'one gap' } },
    { id: 'x1', label: 'fix plan (top·high)', start: 170, end: 180, result: triage },
    { id: 'f1b', label: 'F1 build 1/3 (haiku·low)', start: 180, end: 185 },
    { id: 'f1r', label: 'F1 review 1/3 (sonnet·high)', start: 185, end: 190, result: ok },
    { id: 'i2', label: 'integrate (top·high)', start: 190, end: 195 },
    { id: 'v2', label: 'final review (top·max)', start: 195, end: 200, result: { verdict: 'ship', summary: 'all fixed' }, ...second },
  ]
}

function build(list: Step[], runEnd = 200) {
  const store = D.createStore()
  let text = line({ type: 'launched' })
  list.forEach((s, i) => {
    D.spawned(store, { agentId: s.id, description: s.label, subagentType: 'workflow-subagent', model: 'm', runId: RUN, index: i, toolUseId: 'toolu_rf', isTeammate: false }, s.start * SEC)
    D.turnEnded(store, s.id, s.outcome ?? 'answer', s.end * SEC)
    text += line({ type: 'started', agentId: s.id, label: s.label, phase: 'run', key: s.id })
    if (s.result !== undefined) text += line({ type: 'result', agentId: s.id, key: s.id, result: s.result })
  })
  D.absorbJournal(store, RUN, text, runEnd * SEC)
  const run = store.runs.get(RUN) as RunRow
  run.endedAt = runEnd * SEC
  const rows = [...store.agents.values()] as AgentRow[]
  return (at: number) => {
    const s = sprintOf(run, rows, at * SEC)
    if (!s) throw new Error('not a sprint')
    return { s, f: forecast(s, at * SEC) }
  }
}

test('after a fix round, the finished sprint names the chain with the most actual minutes, not the fix ticket that ended last', () => {
  const { s, f } = build(steps())(205)
  expect(s.stage).toBe('done')
  expect(s.round).toBe(1)
  expect(f.criticalPath).toEqual(['T1', 'T2', 'T3'])
  expect(headline(s, f)).toContain('longest chain T1 → T2 → T3 took 2:00')
})

test('while a fix round runs, the live forecast still follows that round', () => {
  const { s, f } = build(steps())(182)
  expect(s.stage).toBe('building')
  expect(f.criticalPath).toEqual(['F1'])
})

test('replaying the gap between rounds shows the first final review\'s own verdict', () => {
  const at = build(steps())
  expect(at(165).s.stage).toBe('done')
  expect(at(165).s.final?.verdict).toBe('fix first')
  expect(at(205).s.final?.verdict).toBe('ship')
})

test('when the fix round\'s final review fails without a verdict, the sprint shows none instead of the earlier one', () => {
  const { s } = build(steps({ outcome: 'error', result: undefined }))(205)
  expect(s.stage).toBe('done')
  expect(s.final).toBe(null)
})

test('two final reviews that say the same words each keep their own verdict', () => {
  const same = { verdict: 'fix first', summary: 'one gap' }
  const { s } = build(steps({ result: same }))(205)
  expect(s.final).toEqual(same)
})

test('in replay, headlines count each agent\'s time up to the cursor, not to its end', () => {
  const at = build(steps())
  const fixPlan = at(175)
  expect(fixPlan.s.stage).toBe('deciding')
  expect(headline(fixPlan.s, fixPlan.f)).toContain('worked 0:05')
  const finalReview = at(197)
  expect(finalReview.s.stage).toBe('reviewing')
  expect(headline(finalReview.s, finalReview.f)).toContain('Final review running 0:02')
})
