import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { HERO_RECENT_MS, heroStatus, heroTiles, laneRowIds, minutesLeft, pickHero, sprintViews, viewAt } from '../hooks/hero'
import type { AgentRow, Deck, PlanTicket, RunRow, Verdict } from '../types'

const SEC = 1000

type World = { store: D.Store; next: number }

const world = (): World => ({ store: D.createStore(), next: 1 })

// Starts an agent in a run at `start` seconds; ends it at `end` seconds when given.
const add = (w: World, runId: string, label: string, start: number, end: number | null = null, out = 0): AgentRow => {
  const id = `a${w.next}`
  D.spawned(w.store, { agentId: id, description: label, subagentType: 'workflow-subagent', model: 'claude-opus-5-5', runId, index: w.next, toolUseId: `toolu_${runId}`, isTeammate: false }, start * SEC)
  w.next += 1
  if (end !== null) D.turnEnded(w.store, id, 'answer', end * SEC)
  const row = w.store.agents.get(id) as AgentRow
  row.out = out
  return row
}

const runOf = (w: World, id: string): RunRow => w.store.runs.get(id) as RunRow
const tk = (id: string, deps: string[] = [], kind = 'judgment'): PlanTicket => ({ id, title: `title ${id}`, kind, dependsOn: deps, estimateMin: null })
const pass: Verdict = { pass: true, summary: 'ok', issue: '' }
const fail: Verdict = { pass: false, summary: 'no', issue: 'broken' }
const deckOf = (w: World, now: number): Deck => D.snapshot(w.store, now * SEC)

// Run wf_a: T1 passed, T2 on its second build after one failed review, T3 and T4 waiting.
function liveSprint(w: World): { planner: AgentRow; rows: AgentRow[] } {
  const planner = add(w, 'wf_a', 'plan (top·max)', 0, 50)
  const b1 = add(w, 'wf_a', 'T1 build 1/3 (sonnet·high)', 60, 100, 500)
  const r1 = add(w, 'wf_a', 'T1 review 1/3 (top·high)', 100, 130)
  const b2 = add(w, 'wf_a', 'T2 build 1/3 (sonnet·high)', 60, 90, 700)
  const r2 = add(w, 'wf_a', 'T2 review 1/3 (top·high)', 90, 120)
  const b2b = add(w, 'wf_a', 'T2 build 2/3 (top·high)', 120, null, 1200)
  const run = runOf(w, 'wf_a')
  run.plan = [tk('T1'), tk('T2'), tk('T3', ['T2']), tk('T4', ['T3'])]
  run.planFrom = 'planner'
  run.verdicts[r1.id] = pass
  run.verdicts[r2.id] = fail
  return { planner, rows: [b1, r1, b2, r2, b2b] }
}

test('a cursor on a run clamps to its span and sets replaying; a cursor on another run leaves it live', () => {
  const w = world()
  liveSprint(w)
  const run = runOf(w, 'wf_a')
  const rows = deckOf(w, 200).agents
  const now = 200 * SEC

  const mid = viewAt(run, rows, { runId: 'wf_a', at: 100 * SEC }, now)
  expect(mid?.replaying).toBe(true)
  expect(mid?.at).toBe(100 * SEC)
  expect(mid?.s.at).toBe(100 * SEC)
  expect(mid?.f.at).toBe(100 * SEC)

  const early = viewAt(run, rows, { runId: 'wf_a', at: run.startedAt - 5000 }, now)
  expect(early?.at).toBe(run.startedAt)
  const late = viewAt(run, rows, { runId: 'wf_a', at: 9999 * SEC }, now)
  expect(late?.at).toBe(now)

  const other = viewAt(run, rows, { runId: 'wf_other', at: 100 * SEC }, now)
  expect(other?.replaying).toBe(false)
  expect(other?.at).toBe(now)
  const none = viewAt(run, rows, null, now)
  expect(none?.replaying).toBe(false)
  expect(none?.at).toBe(now)
})

test('a finished run clamps a late cursor to the moment it ended', () => {
  const w = world()
  liveSprint(w)
  const run = runOf(w, 'wf_a')
  run.endedAt = 400 * SEC
  const v = viewAt(run, deckOf(w, 500).agents, { runId: 'wf_a', at: 450 * SEC }, 500 * SEC)
  expect(v?.at).toBe(400 * SEC)
})

test('a non-sprint workflow run gives no view', () => {
  const w = world()
  add(w, 'wf_plain', 'summarize the docs', 0, 30)
  const deck = deckOf(w, 60)
  expect(sprintViews(deck, null)).toEqual([])
  expect(pickHero([])).toBe(null)
  expect(viewAt(deck.runs[0] as RunRow, deck.agents, null, 60 * SEC)).toBe(null)
})

test('sprintViews lists the newest run first, and replay computes only the cursor run at the cursor', () => {
  const w = world()
  liveSprint(w)
  add(w, 'wf_b', 'plan (top·max)', 300, null)
  const runB = runOf(w, 'wf_b')
  runB.startedAt = 300 * SEC
  const deck = deckOf(w, 400)
  const views = sprintViews(deck, { runId: 'wf_a', at: 100 * SEC })
  expect(views.map(v => v.run.id)).toEqual(['wf_b', 'wf_a'])
  expect(views[0]?.at).toBe(400 * SEC)
  expect(views[0]?.replaying).toBe(false)
  expect(views[1]?.at).toBe(100 * SEC)
  expect(views[1]?.replaying).toBe(true)
})

test('pickHero prefers the replaying view, then the newest live sprint, then a sprint that just finished', () => {
  const w = world()
  liveSprint(w)
  runOf(w, 'wf_a').startedAt = 10 * SEC
  add(w, 'wf_b', 'plan (top·max)', 300, null)
  runOf(w, 'wf_b').startedAt = 300 * SEC
  add(w, 'wf_c', 'plan (top·max)', 100, 120)
  const runC = runOf(w, 'wf_c')
  runC.startedAt = 100 * SEC
  runC.endedAt = 150 * SEC
  const deck = deckOf(w, 400)

  expect(pickHero(sprintViews(deck, { runId: 'wf_a', at: 100 * SEC }))?.run.id).toBe('wf_a')
  expect(pickHero(sprintViews(deck, null))?.run.id).toBe('wf_b')

  const finishedOnly = sprintViews(deckOf(w, 500), null).filter(v => v.run.id === 'wf_c')
  expect(finishedOnly.length).toBe(1)
  expect(pickHero(finishedOnly)).toBe(null)
  const justEnded = sprintViews(deckOf(w, 270), null).filter(v => v.run.id === 'wf_c')
  expect(pickHero(justEnded)?.run.id).toBe('wf_c')

  runOf(w, 'wf_a').endedAt = 200 * SEC
  runOf(w, 'wf_b').endedAt = 350 * SEC
  const allDone = sprintViews(deckOf(w, 400), null)
  expect(allDone.every(v => v.s.endedAt !== null)).toBe(true)
  expect(pickHero(allDone)?.run.id).toBe('wf_b')
})

test('a finished sprint leads for five minutes, and not after', () => {
  expect(HERO_RECENT_MS).toBe(5 * 60 * SEC)
  const w = world()
  add(w, 'wf_c', 'plan (top·max)', 100, 120)
  const run = runOf(w, 'wf_c')
  run.startedAt = 100 * SEC
  run.endedAt = 150 * SEC
  expect(pickHero(sprintViews(deckOf(w, 150 + 120), null))?.run.id).toBe('wf_c')
  expect(pickHero(sprintViews(deckOf(w, 150 + 1800), null))).toBe(null)
})

test('hero tiles count passed, working, waiting and retries, with values the tile font can draw', () => {
  const w = world()
  liveSprint(w)
  const deck = deckOf(w, 200)
  const v = sprintViews(deck, null)[0]
  if (!v) throw new Error('no view')
  const tiles = heroTiles(v)
  expect(tiles.map(t => t.label)).toEqual(['PASSED OF 4', 'MIN LEFT', 'WORKING', 'WAITING', 'RETRIES', 'TOKENS OUT'])
  const by = (label: string) => tiles.find(t => t.label === label)?.value
  expect(by('PASSED OF 4')).toBe('1')
  expect(by('WORKING')).toBe('1')
  expect(by('WAITING')).toBe('2')
  expect(by('RETRIES')).toBe('1')
  expect(by('TOKENS OUT')).toBe('2.4k')
  const left = minutesLeft(v)
  expect(left === null ? by('MIN LEFT') === '-' : by('MIN LEFT') === String(left)).toBe(true)
  for (const t of tiles) expect(/^[0-9kM.%-]+$/.test(t.value)).toBe(true)
  expect(tiles.find(t => t.label === 'RETRIES')?.color).not.toBe(tiles.find(t => t.label === 'WAITING')?.color)
})

test('retries tile is dim at zero and the minutes tile shows a dash while planning', () => {
  const w = world()
  add(w, 'wf_p', 'plan (top·max)', 0, null)
  const v = sprintViews(deckOf(w, 30), null)[0]
  if (!v) throw new Error('no view')
  expect(v.s.stage).toBe('deciding')
  expect(minutesLeft(v)).toBe(null)
  const tiles = heroTiles(v)
  expect(tiles.find(t => t.label === 'MIN LEFT')?.value).toBe('-')
  expect(tiles.find(t => t.label === 'RETRIES')?.value).toBe('0')
  expect(tiles.find(t => t.label === 'RETRIES')?.color).toBe('#6c7086')
  for (const t of tiles) expect(/^[0-9kM.%-]+$/.test(t.value)).toBe(true)
})

test('heroStatus is "sprint done" for a finished sprint, "planning" while deciding, else passed and minutes left', () => {
  const w = world()
  liveSprint(w)
  add(w, 'wf_p', 'plan (top·max)', 0, null)
  runOf(w, 'wf_p').startedAt = 190 * SEC
  const deck = deckOf(w, 200)
  const views = sprintViews(deck, null)
  const planning = views.find(v => v.run.id === 'wf_p')
  const live = views.find(v => v.run.id === 'wf_a')
  if (!planning || !live) throw new Error('missing view')
  expect(heroStatus(planning)).toBe('planning')
  const left = minutesLeft(live)
  expect(left).not.toBe(null)
  expect(heroStatus(live)).toBe(`1 of 4 passed · ${left}m left`)

  const run = runOf(w, 'wf_a')
  run.endedAt = 400 * SEC
  const done = viewAt(run, deckOf(w, 500).agents, null, 500 * SEC)
  if (!done) throw new Error('no view')
  expect(done.s.stage).toBe('done')
  expect(heroStatus(done)).toBe('sprint done')
  expect(minutesLeft(done)).toBe(null)
  const text = heroStatus(planning) + heroStatus(live) + heroStatus(done)
  expect(/^[\x20-\x7e·]*$/.test(text)).toBe(true)
})

test('laneRowIds holds the build and review rows but not the planner or closers', () => {
  const w = world()
  const { planner, rows } = liveSprint(w)
  const closer = add(w, 'wf_a', 'integrate (top·high)', 300, null)
  const v = viewAt(runOf(w, 'wf_a'), deckOf(w, 400).agents, null, 400 * SEC)
  if (!v) throw new Error('no view')
  const ids = laneRowIds(v)
  for (const row of rows) expect(ids.has(row.id)).toBe(true)
  expect(ids.has(planner.id)).toBe(false)
  expect(ids.has(closer.id)).toBe(false)
  expect(ids.size).toBe(rows.length)
})

test('rewinding a still-running sprint scales a running agent by the share of time before the cursor', () => {
  const w = world()
  add(w, 'wf_r', 'plan (top·max)', 0, 10)
  add(w, 'wf_r', 'T1 build 1/3 (sonnet·high)', 70, null, 50_000)
  const run = runOf(w, 'wf_r')
  run.plan = [tk('T1')]
  run.planFrom = 'planner'
  const rows = deckOf(w, 170).agents
  const now = 170 * SEC

  const back = viewAt(run, rows, { runId: 'wf_r', at: 80 * SEC }, now)
  if (!back) throw new Error('no view')
  expect(back.s.lanes[0]?.tokens).toBe(5000)
  expect(back.s.tokens).toBe(5000)
  expect(heroTiles(back).find(t => t.label === 'TOKENS OUT')?.value).toBe('5.0k')

  const before = viewAt(run, rows, { runId: 'wf_r', at: 60 * SEC }, now)
  expect(before?.s.tokens).toBe(0)

  const live = viewAt(run, rows, null, now)
  expect(live?.s.lanes[0]?.tokens).toBe(50_000)
  expect(live?.s.tokens).toBe(50_000)
})

test('TOKENS OUT counts the planner and the closers as well as the lanes', () => {
  const w = world()
  add(w, 'wf_t', 'plan (top·max)', 0, 10, 3000)
  add(w, 'wf_t', 'T1 build 1/3 (sonnet·high)', 20, 40, 5000)
  const r1 = add(w, 'wf_t', 'T1 review 1/3 (top·high)', 40, 50, 1000)
  add(w, 'wf_t', 'integrate (top·high)', 60, 70, 2000)
  add(w, 'wf_t', 'final review (top·high)', 70, null, 4000)
  const run = runOf(w, 'wf_t')
  run.plan = [tk('T1')]
  run.planFrom = 'planner'
  run.verdicts[r1.id] = pass
  const v = viewAt(run, deckOf(w, 80).agents, null, 80 * SEC)
  if (!v) throw new Error('no view')
  expect(v.s.lanes[0]?.tokens).toBe(6000)
  expect(v.s.tokens).toBe(15_000)
  expect(heroTiles(v).find(t => t.label === 'TOKENS OUT')?.value).toBe('15k')
})

test('a cursor while the critic is live shows the planner draft: stage deciding, draft true, the draft tickets', () => {
  const w = world()
  add(w, 'wf_c', 'plan (top·max)', 0, 20)
  const critic = add(w, 'wf_c', 'plan critic (top·max)', 20, 50)
  add(w, 'wf_c', 'T1 build 1/3 (sonnet·high)', 60, 80)
  const run = runOf(w, 'wf_c')
  run.draft = [tk('T1'), tk('T2', ['T1']), tk('T3', ['T2'])]
  run.plan = [tk('T1'), tk('T2', ['T1'])]
  run.planFrom = 'critic'
  const rows = deckOf(w, 100).agents
  expect(critic.id).toBeTruthy()

  const during = viewAt(run, rows, { runId: 'wf_c', at: 30 * SEC }, 100 * SEC)
  if (!during) throw new Error('no view')
  expect(during.s.stage).toBe('deciding')
  expect(during.s.draft).toBe(true)
  expect(during.s.lanes.map(l => l.id)).toEqual(['T1', 'T2', 'T3'])

  const after = viewAt(run, rows, { runId: 'wf_c', at: 55 * SEC }, 100 * SEC)
  expect(after?.s.draft).toBe(false)
  expect(after?.s.lanes.map(l => l.id)).toEqual(['T1', 'T2'])
})
