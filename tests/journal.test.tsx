import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'

const LABELS: [string, string][] = [
  ['p1', 'plan (top·max)'],
  ['c1', 'plan critic (top·high)'],
  ['r1', 'T1 review 1/3 (sonnet·high)'],
  ['r2', 'T2 review 1/3 (sonnet·high)'],
  ['f1', 'final review (top·max)'],
]

function seed(): D.Store {
  const store = D.createStore()
  LABELS.forEach(([agentId, description], i) => {
    D.spawned(store, { agentId, description, subagentType: 'workflow-subagent', model: 'm', runId: 'wf_j', index: i, toolUseId: 'toolu_j', isTeammate: false }, 1000)
  })
  return store
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const started = (agentId: string, label: string) => line({ type: 'started', agentId, label, phase: 'p', key: agentId })
const result = (agentId: string, r: unknown) => line({ type: 'result', agentId, key: agentId, result: r })

const planned = { tickets: [
  { id: 'T1', title: 'First', kind: 'routine', dependsOn: [], estimateMin: 5 },
  { id: 'T2', title: 'Second', kind: 'hard', dependsOn: ['T1'] },
] }
const checked = { tickets: [
  { id: 'T1', title: 'First, renamed', kind: 'routine', dependsOn: [], estimateMin: 4 },
  { id: 'T2', title: 'Second', kind: 'hard', dependsOn: ['T1'] },
  { id: 'T3', title: 'Added', kind: 'mechanical', dependsOn: ['T1', 'T2'], estimateMin: 0 },
] }

const head = LABELS.map(([id, label]) => started(id, label)).join('')
const full =
  head +
  result('p1', planned) +
  result('c1', checked) +
  result('r1', { pass: true, issues: [], summary: 'looks right' }) +
  result('r2', { pass: false, issues: ['missing case'], summary: 'not done' }) +
  result('f1', { verdict: 'ship', summary: 'all good', issues: [] })

const texts = (store: D.Store) => store.feed.map(f => f.text)

test('the critic plan, both verdicts and the final review are recorded', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', full, 5000)
  const run = store.runs.get('wf_j')!
  expect(run.planFrom).toBe('critic')
  expect(run.plan?.map(t => t.id)).toEqual(['T1', 'T2', 'T3'])
  expect(run.plan?.[0]?.title).toBe('First, renamed')
  expect(run.plan?.[0]?.estimateMin).toBe(4)
  expect(run.plan?.[1]?.estimateMin).toBe(null)
  expect(run.plan?.[2]?.estimateMin).toBe(null)
  expect(run.plan?.[2]?.dependsOn).toEqual(['T1', 'T2'])
  expect(run.verdicts['r1']).toEqual({ pass: true, summary: 'looks right', issue: '' })
  expect(run.verdicts['r2']).toEqual({ pass: false, summary: 'not done', issue: 'missing case' })
  expect(run.final).toEqual({ verdict: 'ship', summary: 'all good' })
  expect(texts(store)).toContain('T1 passed review (try 1 of 3)')
  expect(texts(store)).toContain('T2 failed review: missing case')
  expect(texts(store)).toContain('draft plan ready: 2 tickets')
  expect(texts(store)).toContain('plan checked: 3 tickets')
  expect(texts(store)).toContain('final review: ship · all good')
  expect(store.feed.find(f => f.text.startsWith('T1 passed'))?.kind).toBe('done')
  expect(store.feed.find(f => f.text.startsWith('T2 failed'))?.kind).toBe('fail')
  expect(store.feed.find(f => f.text.startsWith('T1 passed'))?.at).toBe(5000)
})

test('absorbing the same text again adds nothing', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', full, 5000)
  const before = JSON.stringify(D.snapshot(store, 1))
  store.dirty = false
  D.absorbJournal(store, 'wf_j', full, 6000)
  expect(JSON.stringify(D.snapshot(store, 1))).toBe(before)
  expect(store.dirty).toBe(false)
})

test('a half-written last line waits until it is complete', () => {
  const store = seed()
  const lines = full.split('\n').filter(Boolean)
  const last = lines[lines.length - 1]!
  const partial = lines.slice(0, -1).join('\n') + '\n' + last.slice(0, 20)
  D.absorbJournal(store, 'wf_j', partial, 1)
  expect(store.runs.get('wf_j')!.final).toBe(null)
  D.absorbJournal(store, 'wf_j', partial + last.slice(20), 2)
  expect(store.runs.get('wf_j')!.final).toBe(null)
  D.absorbJournal(store, 'wf_j', full, 3)
  expect(store.runs.get('wf_j')!.final?.verdict).toBe('ship')
})

test('a planner result after the critic does not replace the plan', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', head + result('c1', checked), 1)
  D.absorbJournal(store, 'wf_j', head + result('c1', checked) + result('p1', planned), 2)
  const run = store.runs.get('wf_j')!
  expect(run.planFrom).toBe('critic')
  expect(run.plan?.length).toBe(3)
  expect(texts(store)).not.toContain('draft plan ready: 2 tickets')
})

test('repeated ids become T1 and T1 prime', () => {
  const store = seed()
  const dup = { tickets: [{ id: 'T1', title: 'a' }, { id: ' T1 ', title: 'b' }, { id: '', title: 'c' }] }
  D.absorbJournal(store, 'wf_j', head + result('p1', dup), 1)
  const plan = store.runs.get('wf_j')!.plan!
  expect(plan.map(t => t.id)).toEqual(['T1', "T1'"])
  expect(plan[0]?.kind).toBe('judgment')
  expect(plan[0]?.dependsOn).toEqual([])
})

test('a restored deck re-reading the whole journal adds no feed lines', () => {
  const first = seed()
  D.absorbJournal(first, 'wf_j', full, 5000)
  const second = D.createStore()
  D.restore(second, D.snapshot(first, 6000))
  const count = second.feed.length
  D.absorbJournal(second, 'wf_j', full, 7000)
  expect(second.feed.length).toBe(count)
  expect(second.runs.get('wf_j')!.plan?.length).toBe(3)
})

test('a restart that shrinks the file starts over without repeating feed lines', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', full, 1)
  const count = store.feed.length
  D.absorbJournal(store, 'wf_j', head, 2)
  D.absorbJournal(store, 'wf_j', full, 3)
  expect(store.feed.length).toBe(count)
})

test('journalWanted is true while live and false once ended and read again', () => {
  const store = seed()
  const run = store.runs.get('wf_j')!
  D.absorbJournal(store, 'wf_j', full, 1)
  expect(D.journalWanted(store, run)).toBe(true)
  run.endedAt = 9000
  expect(D.journalWanted(store, run)).toBe(true)
  D.absorbJournal(store, 'wf_j', full, 2)
  expect(D.journalWanted(store, run)).toBe(false)
})

test('clearFinished drops the journal entry with its run', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', full, 1)
  store.runs.get('wf_j')!.endedAt = 9000
  D.clearFinished(store)
  expect(store.journals.has('wf_j')).toBe(false)
})

const fixLine = (agentId: string) => started(agentId, 'fix plan (top·high)')
const fixed = { tickets: [
  { id: 'T1', title: 'Fix one', kind: 'routine', dependsOn: [], estimateMin: 3 },
  { id: 'T2', title: 'Fix two', kind: 'routine', dependsOn: ['T1', 'T1', 'T9'] },
] }

function seedFix(limits?: unknown): D.Store {
  const store = D.createStore()
  if (limits !== undefined) D.noteLimit(store, 'toolu_f', limits)
  const labels: [string, string][] = [...LABELS, ['x1', 'fix plan (top·high)']]
  labels.forEach(([agentId, description], i) => {
    D.spawned(store, { agentId, description, subagentType: 'workflow-subagent', model: 'm', runId: 'wf_j', index: i, toolUseId: 'toolu_f', isTeammate: false }, 1000)
  })
  return store
}

test('an issues-mode fix plan comes out as F1 and F2 with its dependencies mapped', () => {
  const store = seedFix()
  D.absorbJournal(store, 'wf_j', fixLine('x1') + result('x1', fixed), 1)
  const run = store.runs.get('wf_j')!
  expect(run.planFrom).toBe(null)
  expect(run.plan?.map(t => t.id)).toEqual(['F1', 'F2'])
  expect(run.plan?.[1]?.dependsOn).toEqual(['F1'])
  expect(run.plan?.[0]?.from).toBe('x1')
  expect(run.plan?.[0]?.dropped).toBe(undefined)
  expect(run.plan?.[0]?.estimateMin).toBe(3)
  expect(texts(store)).toContain('fix plan ready: 2 tickets')
})

test('a fix round after a critic plan skips F ids already used and keeps the critic tickets', () => {
  const store = seedFix()
  const fs = { tickets: [
    { id: 'F1', title: 'a', dependsOn: [] },
    { id: 'F2', title: 'b', dependsOn: ['F1'] },
    { id: 'F3', title: 'c', dependsOn: [] },
  ] }
  D.absorbJournal(store, 'wf_j', head + result('c1', fs), 1)
  D.absorbJournal(store, 'wf_j', head + result('c1', fs) + fixLine('x1') + result('x1', fixed), 2)
  const run = store.runs.get('wf_j')!
  expect(run.planFrom).toBe('critic')
  expect(run.plan?.map(t => t.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5'])
  expect(run.plan?.slice(0, 3).every(t => t.from === undefined)).toBe(true)
  expect(run.plan?.[4]?.dependsOn).toEqual(['F4'])
  expect(run.plan?.[4]?.from).toBe('x1')
})

test('a later critic result keeps the fix tickets after its own', () => {
  const store = seedFix()
  D.absorbJournal(store, 'wf_j', head + fixLine('x1') + result('x1', fixed) + result('c1', checked), 1)
  const run = store.runs.get('wf_j')!
  expect(run.plan?.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'F1', 'F2'])
})

test('maxTickets 2 marks the third ticket dropped while numbering still counts it', () => {
  const store = seedFix({ maxTickets: 2 })
  const run = store.runs.get('wf_j')!
  expect(run.maxTickets).toBe(2)
  const three = { tickets: [{ id: 'A' }, { id: 'B', dependsOn: ['C'] }, { id: 'C' }] }
  D.absorbJournal(store, 'wf_j', fixLine('x1') + result('x1', three), 1)
  expect(run.plan?.map(t => `${t.id}${t.dropped ? '-' : ''}`)).toEqual(['F1', 'F2', 'F3-'])
  expect(run.plan?.[1]?.dependsOn).toEqual(['F3'])
  expect(texts(store)).toContain('fix plan ready: 2 tickets')
  D.absorbJournal(store, 'wf_j', fixLine('x1') + result('x1', three) + started('x2', 'fix plan (top·high)') + result('x2', { tickets: [{ id: 'Z' }] }), 2)
  expect(run.plan?.map(t => t.id)).toEqual(['F1', 'F2', 'F3', 'F4'])
  expect(run.plan?.[3]?.from).toBe('x2')
})

test('the ticket cap marks planner and critic tickets too', () => {
  const store = seedFix({ maxTickets: 2 })
  D.absorbJournal(store, 'wf_j', head + result('p1', planned) + result('c1', checked), 1)
  const run = store.runs.get('wf_j')!
  expect(run.plan?.map(t => !!t.dropped)).toEqual([false, false, true])
  expect(texts(store)).toContain('plan checked: 2 tickets')
})

test('re-reading a journal with a fix plan changes nothing and adds no feed lines', () => {
  const store = seedFix()
  const text = full + fixLine('x1') + result('x1', fixed)
  D.absorbJournal(store, 'wf_j', text, 1)
  const before = JSON.stringify(D.snapshot(store, 1))
  store.dirty = false
  D.absorbJournal(store, 'wf_j', head, 2)
  D.absorbJournal(store, 'wf_j', text, 3)
  expect(JSON.stringify(D.snapshot(store, 1))).toBe(before)
  const second = D.createStore()
  D.restore(second, D.snapshot(store, 4))
  const count = second.feed.length
  D.absorbJournal(second, 'wf_j', text, 5)
  expect(second.feed.length).toBe(count)
  expect(second.runs.get('wf_j')!.plan?.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'F1', 'F2'])
  expect(second.runs.get('wf_j')!.plan?.[3]?.from).toBe('x1')
})

test('noteLimit reads an object and clamps the way the workflow does; a string is the goal, so it sets no limit', () => {
  const store = D.createStore()
  D.noteLimit(store, 'a', { maxTickets: 5 })
  D.noteLimit(store, 'b', JSON.stringify({ goal: 'g', maxTickets: 99 }))
  D.noteLimit(store, 'c', '{not json')
  D.noteLimit(store, 'd', { maxTickets: 0 })
  D.noteLimit(store, 'e', { maxTickets: -3 })
  expect([...store.runLimits.entries()]).toEqual([['a', 5], ['b', 16], ['c', 16], ['d', 16], ['e', 1]])
  D.spawned(store, { agentId: 'z', description: 'plan (top·max)', subagentType: 'workflow-subagent', model: 'm', runId: 'wf_n', index: 0, toolUseId: 'a', isTeammate: false }, 1)
  expect(store.runs.get('wf_n')!.maxTickets).toBe(5)
  D.spawned(store, { agentId: 'y', description: 'plan (top·max)', subagentType: 'workflow-subagent', model: 'm', runId: 'wf_o', index: 0, toolUseId: 'none', isTeammate: false }, 1)
  expect(store.runs.get('wf_o')!.maxTickets).toBe(null)
  const back = D.createStore()
  D.restore(back, D.snapshot(store, 2))
  expect(back.runs.get('wf_n')!.maxTickets).toBe(5)
})

test('the planner draft survives the critic plan, a snapshot and a restore', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', head + result('p1', planned) + result('c1', checked), 5000)
  const run = store.runs.get('wf_j')!
  expect(run.plan?.map(t => t.id)).toEqual(['T1', 'T2', 'T3'])
  expect(run.draft?.map(t => t.id)).toEqual(['T1', 'T2'])
  expect(run.draft?.[0]?.title).toBe('First')
  const back = D.createStore()
  D.restore(back, D.snapshot(store, 6000))
  expect(back.runs.get('wf_j')!.draft).toEqual(run.draft)
  expect(back.runs.get('wf_j')!.draft).not.toBe(run.draft)
})

test('an old deck with a planner plan and no draft heals the draft from the plan', () => {
  const store = seed()
  D.absorbJournal(store, 'wf_j', head + result('p1', planned), 5000)
  const deck = JSON.parse(JSON.stringify(D.snapshot(store, 6000)))
  delete deck.runs[0].draft
  const back = D.createStore()
  D.restore(back, deck)
  expect(back.runs.get('wf_j')!.draft?.map(t => t.id)).toEqual(['T1', 'T2'])
  const none = JSON.parse(JSON.stringify(D.snapshot(seed(), 1)))
  delete none.runs[0]?.draft
  const b2 = D.createStore()
  D.restore(b2, none)
  for (const r of b2.runs.values()) expect(r.draft).toBe(null)
})
