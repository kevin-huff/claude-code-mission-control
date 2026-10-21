import { expect, test } from 'claude-code/testing'

import * as D from '../hooks/deck'
import { forecast } from '../hooks/forecast'
import { flightCanvas, flightColumns, flightPlan, flightSpan } from '../hooks/flight'
import { sprintOf } from '../hooks/sprint'
import type { AgentRow, PlanTicket, RunRow, Sprint } from '../types'

const SEC = 1000
const MIN = 60 * SEC
const EL = { Box: 'Box', Text: 'Text', Raster: 'Raster' }

type Node = { type?: string; props?: Record<string, unknown>; children?: Node } | string | number | null | undefined | Node[]
function text(node: Node): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  return text(node.children as Node)
}
function rows(node: Node, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach(n => rows(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'Text') out.push(text(node))
    else rows(node.children as Node, out)
  }
  return out
}

const tk = (id: string, dependsOn: string[] = []): PlanTicket => ({ id, title: `title ${id}`, kind: 'judgment', dependsOn, estimateMin: 12 })

// A run shaped like a real one: a long plan and critic (41 minutes), then five tickets, three of them already building at 45 minutes.
function world(at: number) {
  const store = D.createStore()
  let n = 1
  const add = (label: string, start: number, end: number | null, code: 'q' | 'b' | 't' = 'b') => {
    const id = `a${n}`
    D.spawned(store, { agentId: id, description: label, subagentType: 'workflow-subagent', model: 'claude-opus-5-5', runId: 'wf_axis', index: n, toolUseId: 'toolu_axis', isTeammate: false }, start)
    n += 1
    const row = store.agents.get(id) as AgentRow
    for (let t = start; t < (end ?? at); t += 5 * SEC) D.sample(store, row, code, t)
    if (end !== null) D.turnEnded(store, id, 'answer', end)
    return row
  }
  add('plan (top·max)', 0, 40 * MIN, 'q')
  add('plan critic (top·high)', 40 * MIN, 41 * MIN + 25 * SEC, 'q')
  const first = 41 * MIN + 25 * SEC
  add('T1 build 1/3 (sonnet·high)', first, null)
  add('T2 build 1/3 (sonnet·high)', first + 10 * SEC, null)
  add('T3 build 1/3 (sonnet·high)', first + 20 * SEC, null)
  const run = store.runs.get('wf_axis') as RunRow
  run.plan = [tk('T1'), tk('T2'), tk('T3'), tk('T4', ['T1']), tk('T5', ['T2'])]
  run.planFrom = 'critic'
  const all = [...store.agents.values()] as AgentRow[]
  const s = sprintOf(run, all, at) as Sprint
  return { s, f: forecast(s, at), first }
}

test('at 45 minutes the strip starts at the first ticket and its rows are mostly filled', () => {
  const { s, f, first } = world(45 * MIN)
  expect(s.stage).toBe('building')
  const [from, to] = flightSpan(s, f)
  expect(from).toBe(first)
  expect(from).toBeGreaterThan(s.startedAt)
  expect(to).toBeGreaterThan(s.at)
  for (const width of [48, 60, 84, 110, 140]) {
    const cols = flightColumns(width).strip
    const canvas = flightCanvas(s, f, from, to, cols)
    // Every strip column holds a mark on some ticket row; with the axis starting at the run's start, the planning half of the strip would be blank.
    let used = 0
    for (let x = 0; x < cols; x++) if (s.lanes.some((_, y) => canvas.words[(y * cols + x) * 3] !== 0x20)) used++
    expect(used).toBeGreaterThanOrEqual(Math.floor(cols * 0.9))
  }
  const left = D.clock(first - s.startedAt)
  expect(left).toBe('41:25')
  const axis = rows(flightPlan(EL, s, f, { width: 84, terminal: true, replay: false }) as unknown as Node).find(r => r.includes(left))
  expect(axis).toBeDefined()
  expect(axis!.trimStart().startsWith(left)).toBe(true)
  expect(axis!).not.toContain('0:00')
})

test('a sprint still deciding keeps the axis at the start of the run', () => {
  const early = world(30 * MIN)
  expect(early.s.stage).toBe('deciding')
  expect(flightSpan(early.s, early.f)[0]).toBe(early.s.startedAt)
  const { s: built, f } = world(45 * MIN)
  const s = { ...built, stage: 'deciding' as const, at: 30 * MIN, lanes: built.lanes.map(l => ({ ...l, status: 'waiting' as const, startedAt: null, attempts: [] })) }
  expect(flightSpan(s, f)[0]).toBe(s.startedAt)
  const out = rows(flightPlan(EL, s, f, { width: 84, terminal: true, replay: false }) as unknown as Node)
  const axis = out.find(r => r.trimStart().startsWith('0:00'))
  expect(axis).toBeDefined()
})

test('a cursor before the first ticket draws no marker and no history', () => {
  const { s, f } = world(45 * MIN)
  const [from, to] = flightSpan(s, f)
  const early = { ...s, at: from - 5 * MIN, lanes: s.lanes.map(l => ({ ...l, status: 'waiting' as const, startedAt: null, attempts: [] })) }
  for (const width of [48, 84, 140]) {
    const cols = flightColumns(width).strip
    const canvas = flightCanvas(early, f, from, to, cols)
    for (let y = 0; y < early.lanes.length; y++) {
      for (let x = 0; x < cols; x++) {
        const bg = canvas.words[(y * cols + x) * 3 + 2]!
        expect(bg === 0 || bg === 0x01000000 || bg === undefined).toBe(true)
      }
    }
    const out = rows(flightPlan(EL, early, f, { width, terminal: true, replay: true, span: [from, to] }) as unknown as Node)
    expect(out.some(r => r.includes('◆'))).toBe(false)
  }
})

test('the closing line names the round that spoke, never its own', () => {
  const { s, f } = world(45 * MIN)
  const closing = (round: number, verdict: string) =>
    rows(flightPlan(EL, { ...s, round, previous: { verdict, summary: '' } }, f, { width: 110, terminal: true, replay: false }) as unknown as Node).find(r => r.includes('integrate and final review next')) ?? ''
  expect(closing(1, 'fix first')).toMatch(/· the first round said fix first$/)
  expect(closing(2, 'fix first')).toMatch(/· fix round 1 said fix first$/)
  expect(closing(2, 'fix first')).not.toContain('round 2 said')
  expect(closing(3, 'block')).toMatch(/· fix round 2 said block$/)
  expect(closing(0, 'ship')).not.toContain('said')
})
