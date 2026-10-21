import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'

const facts = (agentId: string): D.SpawnFacts => ({
  agentId,
  description: 'T1 build 1/3 (sonnet·high)',
  subagentType: 'workflow-subagent',
  model: 'claude-opus-5-5',
  runId: 'wf_r',
  index: 1,
  toolUseId: 'toolu_wf',
  isTeammate: false,
})

const status = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 20, resets_at: 1800000000 } } })

test('a run spawned with no usage starts with empty sprint fields', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 1000)
  const run = store.runs.get('wf_r')!
  expect(run.plan).toBe(null)
  expect(run.planFrom).toBe(null)
  expect(run.verdicts).toEqual({})
  expect(run.final).toBe(null)
  expect(run.limitBase).toBe(null)
})

test('absorbStatus fills limitBase on live runs and spawn picks it up', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 1000)
  D.absorbStatus(store, status, null)
  expect(store.runs.get('wf_r')!.limitBase?.pct).toBe(20)
  const later = D.createStore()
  D.absorbStatus(later, status, null)
  D.spawned(later, facts('a2'), 1000)
  expect(later.runs.get('wf_r')!.limitBase?.pct).toBe(20)
})

test('an ended run does not get limitBase filled', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 1000)
  store.runs.get('wf_r')!.endedAt = 2000
  D.absorbStatus(store, status, null)
  expect(store.runs.get('wf_r')!.limitBase).toBe(null)
})

test('restore heals runs saved before the new fields', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 1000)
  const deck = D.snapshot(store, 2000)
  const old = { ...deck, runs: deck.runs.map(r => ({ id: r.id, name: r.name, dir: r.dir, startedAt: r.startedAt, endedAt: r.endedAt, phases: r.phases })) }
  const fresh = D.createStore()
  D.restore(fresh, old as never)
  const run = fresh.runs.get('wf_r')!
  expect(run.plan).toBe(null)
  expect(run.verdicts).toEqual({})
  expect(run.limitBase).toBe(null)
})

test('the snapshot shares nothing mutable with the store', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 1000)
  const run = store.runs.get('wf_r')!
  const ticket = { id: 'T1', title: 't', kind: 'routine', dependsOn: ['T0'], estimateMin: 4 }
  run.plan = [ticket]
  run.verdicts = { a1: { pass: true, summary: 's', issue: '' } }
  const deck = D.snapshot(store, 2000)
  deck.runs[0]!.plan![0]!.dependsOn.push('X')
  deck.runs[0]!.verdicts.a1!.pass = false
  expect(ticket.dependsOn).toEqual(['T0'])
  expect(run.verdicts.a1!.pass).toBe(true)
})
