import { expect, test } from 'claude-code/testing'

import { Canvas } from '../hooks/art'
import * as D from '../hooks/deck'
import { flightCanvas, flightColumns, flightPlan, flightSpan } from '../hooks/flight'
import { P } from '../hooks/look'
import type { AgentRow, Attempt, Forecast, Lane, LaneStatus, Sprint } from '../types'

const rgb = (hex: string) => parseInt(hex.slice(1), 16)
const ALLOWED = new Set([0x20, 0x2580, 0x2581, 0x2584, 0x2591])

function agent(store: D.Store, id: string, label: string, start: number, end: number | null, code: 'b' | 't' | 'w' | 'q', model = 'claude-opus-5-5'): AgentRow {
  D.spawned(store, { agentId: id, description: label, subagentType: 'workflow-subagent', model, runId: 'wf_f', index: 1, toolUseId: 'toolu_f', isTeammate: false }, start)
  const row = store.agents.get(id)!
  for (let t = start; t < (end ?? start + 20_000); t += 2_000) D.sample(store, row, code, t)
  if (end !== null) D.turnEnded(store, id, 'answer', end)
  return row
}

function lane(id: string, status: LaneStatus, o: Partial<Lane> = {}): Lane {
  return { id, title: `title of ${id}`, kind: 'routine', dependsOn: [], estimateMin: 4, status, attempts: [], maxAttempts: 3, startedAt: null, endedAt: null, tokens: 0, live: null, ...o }
}

function attempt(n: number, rung: number, build: AgentRow | null, review: AgentRow | null, pass: boolean | null): Attempt {
  return { n, tier: 'sonnet·high', rung, build, review, verdict: pass === null ? null : { pass, summary: '', issue: '' } }
}

function fixture(endedAt: number | null = null) {
  const store = D.createStore()
  const b1 = agent(store, 'b1', 'T1 build 1/3 (sonnet·high)', 0, 60_000, 'b')
  const r1 = agent(store, 'r1', 'T1 review 1/3 (top·high)', 60_000, 90_000, 't')
  const b2 = agent(store, 'b2', 'T2 build 1/3 (sonnet·high)', 0, 50_000, 'w')
  const r2 = agent(store, 'r2', 'T2 review 1/3 (top·high)', 50_000, 80_000, 't')
  const p = agent(store, 'p1', 'plan (top·max)', 0, 0, 'q')
  const lanes = [
    lane('T1', 'passed', { attempts: [attempt(1, 2, b1, r1, true)], startedAt: 0, endedAt: 90_000, tokens: 12_000 }),
    lane('T2', 'failed', { attempts: [attempt(1, 2, b2, r2, false)], startedAt: 0, endedAt: 80_000 }),
    lane('T3', 'waiting', { dependsOn: ['T1'], title: 'critical waiting' }),
    lane('T4', 'waiting', { dependsOn: ['T1'], title: 'side waiting' }),
  ]
  const s: Sprint = { runId: 'wf_f', name: 'sprint', startedAt: 0, endedAt, at: 120_000, round: 0, stage: 'building', draft: false, lanes, deciders: [p], closers: [], final: null, tokens: 0, previous: null }
  const proj = (id: string, start: number, finish: number, critical: boolean) => ({ id, start, finish, slackMs: 0, critical, after: null })
  const f: Forecast = {
    at: 120_000,
    factor: 1,
    projections: { T3: proj('T3', 150_000, 250_000, true), T4: proj('T4', 120_000, 180_000, false) },
    criticalPath: ['T3'],
    longPole: 'T3',
    waiting: [],
    buildEnd: 250_000,
    eta: 300_000,
  }
  return { s, f }
}

const cell = (c: Canvas, x: number, y: number) => ({ ch: c.words[(y * c.cols + x) * 3]!, fg: c.words[(y * c.cols + x) * 3 + 1]!, bg: c.words[(y * c.cols + x) * 3 + 2]! })

test('columns add up to the width and the pips drop under 70', () => {
  for (const width of [40, 60, 84, 100, 110, 140]) {
    const c = flightColumns(width)
    expect(2 + c.idW + c.titleW + 1 + c.pipsW + c.strip + c.rightW + 1).toBe(width)
    expect(c.strip).toBeGreaterThanOrEqual(8)
  }
  expect(flightColumns(60).pipsW).toBe(0)
  expect(flightColumns(69).pipsW).toBe(0)
  expect(flightColumns(70).pipsW).toBe(4)
  expect(flightColumns(110)).toEqual({ idW: 5, titleW: 29, pipsW: 4, rightW: 16, strip: 52 })
  expect(flightColumns(84).titleW).toBe(18)
  expect(flightColumns(30).strip).toBeGreaterThanOrEqual(0)
})

test('the span starts at the run start and ends at the build end, the estimate or the end', () => {
  const { s, f } = fixture()
  // Building: the strip stops at the build-end estimate, not the finish estimate.
  expect(flightSpan(s, f)).toEqual([0, 250_000])
  expect(flightSpan({ ...s, stage: 'deciding' }, f)).toEqual([0, 250_000])
  expect(flightSpan({ ...s, stage: 'deciding' }, { ...f, buildEnd: null })).toEqual([0, 120_000])
  expect(flightSpan({ ...s, stage: 'reviewing' }, f)).toEqual([0, 300_000])
  expect(flightSpan({ ...s, endedAt: 200_000 }, f)).toEqual([0, 200_000])
  // The strip starts at the first ticket once one has started, and at the run's start before that.
  const bare = { ...s, lanes: [], deciders: [{ ...s.deciders[0]!, endedAt: 45_000 }], startedAt: 10_000 }
  expect(flightSpan(bare, { ...f, eta: null })[0]).toBe(10_000)
  expect(flightSpan({ ...bare, lanes: s.lanes }, f)[0]).toBe(0)
  expect(flightSpan({ ...bare, lanes: [lane('T1', 'building', { startedAt: 40_000 }), lane('T2', 'building', { startedAt: 30_000 })] }, f)[0]).toBe(30_000)
  expect(flightSpan({ ...bare, lanes: [lane('T1', 'ready')] }, f)[0]).toBe(10_000)
  expect(flightSpan({ ...bare, deciders: [], stage: 'reviewing' }, { ...f, eta: null })).toEqual([10_000, 120_000])
  expect(flightSpan({ ...bare, deciders: [], at: 10_000, stage: 'reviewing' }, { ...f, eta: null })).toEqual([10_000, 70_000])
})

test('titles widen above 100 columns and the columns still add up', () => {
  for (const width of [100, 110, 140]) {
    const c = flightColumns(width)
    expect(2 + c.idW + c.titleW + 1 + c.pipsW + c.strip + c.rightW + 1).toBe(width)
  }
  expect(flightColumns(100).titleW).toBe(24)
  expect(flightColumns(110).titleW).toBe(29)
  expect(flightColumns(140).titleW).toBeGreaterThan(24)
  expect(flightColumns(300).titleW).toBe(40)
})

test('the canvas shows history, projections and the now band', () => {
  const { s, f } = fixture()
  const canvas = flightCanvas(s, f, 0, 300_000, 30)
  expect(canvas.cols).toBe(30)
  expect(canvas.rows).toBe(4)
  // T1: build over cells 0..5, then a review in green over 6..8, then blank until now.
  for (let x = 0; x < 6; x++) expect(cell(canvas, x, 0).ch).toBe(0x2584)
  for (let x = 6; x < 9; x++) {
    expect(cell(canvas, x, 0).ch).toBe(0x2580)
    expect(cell(canvas, x, 0).fg).toBe(rgb(P.green))
  }
  expect(cell(canvas, 10, 0).ch).toBe(0x20)
  // T2 failed: review cells in red, no projection.
  expect(cell(canvas, 6, 1).ch).toBe(0x2580)
  expect(cell(canvas, 6, 1).fg).toBe(rgb(P.red))
  for (let x = 13; x < 30; x++) expect(cell(canvas, x, 1).ch).toBe(0x20)
  // T3 critical, T4 not.
  for (let x = 15; x < 25; x++) {
    expect(cell(canvas, x, 2).ch).toBe(0x2591)
    expect(cell(canvas, x, 2).fg).toBe(rgb(P.peach))
  }
  expect(cell(canvas, 14, 2).ch).toBe(0x20)
  expect(cell(canvas, 25, 2).ch).toBe(0x20)
  for (let x = 12; x < 18; x++) {
    expect(cell(canvas, x, 3).ch).toBe(0x2591)
    expect(cell(canvas, x, 3).fg).toBe(rgb(P.surf2))
  }
  // The now band: cell 12 on every row.
  for (let y = 0; y < 4; y++) expect(cell(canvas, 12, y).bg).toBe(rgb(P.surf1))
  expect(cell(canvas, 11, 0).bg).toBe(0x01000000)
  // Only the allowed glyphs.
  for (let i = 0; i < canvas.cols * canvas.rows; i++) expect(ALLOWED.has(canvas.words[i * 3]!)).toBe(true)
})

test('a finished sprint has no now band', () => {
  const { s, f } = fixture(200_000)
  const canvas = flightCanvas(s, f, 0, 200_000, 20)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 20; x++) expect(cell(canvas, x, y).bg).toBe(0x01000000)
})

test('an idle build cell is a thin baseline and a review of unknown verdict keeps its state color', () => {
  const store = D.createStore()
  const b = agent(store, 'b1', 'T1 build 1/3 (sonnet·high)', 0, 40_000, 'q')
  for (let t = 0; t < 40_000; t += 2_000) D.sample(store, b, 'i', t)
  const r = agent(store, 'r1', 'T1 review 1/3 (top·high)', 40_000, 60_000, 't')
  const { s, f } = fixture()
  const l = lane('T1', 'reviewing', { attempts: [attempt(1, 3, b, r, null)], startedAt: 0 })
  const canvas = flightCanvas({ ...s, lanes: [l] }, { ...f, projections: {} }, 0, 120_000, 12)
  expect([0x2581, 0x2584]).toContain(cell(canvas, 0, 0).ch)
  expect(cell(canvas, 5, 0).ch).toBe(0x2580)
  expect(cell(canvas, 5, 0).fg).not.toBe(rgb(P.green))
  expect(cell(canvas, 5, 0).fg).not.toBe(rgb(P.red))
})

type Node = { type?: unknown; props?: { key?: unknown }; children?: unknown } | string | number | null | undefined | boolean | Node[]

function words(node: Node, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach(n => words(n, out))
  else if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (node && typeof node === 'object') words(node.children as Node, out)
  return out
}

function lines(node: Node): string[] {
  const out: string[] = []
  const walk = (n: Node) => {
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      if (n.type === 'Text') out.push(words(n).join(''))
      else walk(n.children as Node)
    }
  }
  walk(node)
  return out
}

function keys(node: Node, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach(n => keys(n, out))
  else if (node && typeof node === 'object') {
    const k = node.props?.key
    if (typeof k === 'string') out.push(`${String(node.type)}:${k}`)
    keys(node.children as Node, out)
  }
  return out
}

test('the plan draws at every width with the rows, the axis and no Text keys', () => {
  const el = { Box: 'Box', Text: 'Text', Raster: 'Raster' }
  const { s, f } = fixture()
  for (const [width, terminal] of [[110, true], [84, true], [60, true], [84, false], [60, false]] as const) {
    const tree = flightPlan(el, s, f, { width, terminal, replay: false }) as unknown as Node
    const rows = lines(tree)
    expect(rows[0]).toContain('FLIGHT PLAN')
    expect(rows[0]).toContain('1 of 4 passed · about 3 min left')
    expect(rows.some(r => r.startsWith('plan'))).toBe(true)
    expect(rows.some(r => r.includes('integrate and final review next'))).toBe(true)
    expect(rows.some(r => r.includes('after T1'))).toBe(true)
    expect(rows.some(r => r.includes('✗ 1/3'))).toBe(true)
    expect(rows.some(r => r.includes('▄ build'))).toBe(width >= 70)
    expect(keys(tree)[0]).toBe('Box:flight-wf_f')
    expect(keys(tree).filter(k => k.startsWith('Text'))).toEqual([])
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(width)
    if (!terminal) expect(keys(tree)).not.toContain('Raster:flight-strips')
    else expect(keys(tree)).toContain('Raster:flight-strips')
  }
  const replay = lines(flightPlan(el, s, f, { width: 84, terminal: true, replay: true, span: [0, 400_000] }) as unknown as Node)
  expect(replay[0]).toContain('REPLAY')
  expect(replay[0]).toContain('2:00 of 6:40')
})

test('the plan with no tickets says so instead of drawing rows', () => {
  const el = { Box: 'Box', Text: 'Text', Raster: 'Raster' }
  const { s, f } = fixture()
  const tree = flightPlan(el, { ...s, lanes: [] }, { ...f, eta: null, projections: {} }, { width: 84, terminal: true, replay: false }) as unknown as Node
  const rows = lines(tree)
  expect(rows[0]).toContain('planning')
  expect(keys(tree)).not.toContain('Box:flight-rows')
})

test('a finished sprint header says passed and not min left', () => {
  const el = { Box: 'Box', Text: 'Text', Raster: 'Raster' }
  const { s, f } = fixture(200_000)
  for (const stage of ['done', 'building'] as const) {
    const tree = flightPlan(el, { ...s, stage, at: 10_800_000 }, f, { width: 84, terminal: true, replay: false }) as unknown as Node
    const top = lines(tree)[0] ?? ''
    expect(top).toContain('passed')
    expect(top).not.toContain('min left')
  }
  const liveRun = fixture()
  const live = flightPlan(el, liveRun.s, liveRun.f, { width: 84, terminal: true, replay: false }) as unknown as Node
  expect(lines(live)[0]).toContain('min left')
})

function colorOf(node: Node, needle: string): unknown {
  let found: unknown
  const walk = (n: Node) => {
    if (found !== undefined) return
    if (Array.isArray(n)) n.forEach(walk)
    else if (n && typeof n === 'object') {
      const own = typeof n.children === 'string' ? n.children : Array.isArray(n.children) && n.children.every(c => typeof c === 'string') ? (n.children as string[]).join('') : null
      if (n.type === 'Text' && own !== null && own.includes(needle)) found = (n as { props?: { color?: unknown } }).props?.color
      else walk(n.children as Node)
    }
  }
  walk(node)
  return found
}

for (const [verdict, mark, color] of [['ship', '✓', P.green], ['fix first', '✗', P.red]] as const) {
  test(`the closer line shows the final verdict: ${verdict}`, () => {
    const el = { Box: 'Box', Text: 'Text', Raster: 'Raster' }
    const { s, f } = fixture(130_000)
    const store = D.createStore()
    const integ = agent(store, 'i1', 'integrate (sonnet·high)', 90_000, 100_000, 'b')
    const fin = agent(store, 'fr1', 'final review (top·max)', 100_000, 110_000, 't')
    const done: Sprint = { ...s, stage: 'done', closers: [integ, fin], final: { verdict, summary: '' } }
    const tree = flightPlan(el, done, f, { width: 84, terminal: true, replay: false }) as unknown as Node
    const row = lines(tree).find(l => l.includes('final review') && l.includes('integrate'))
    expect(row).toBeDefined()
    expect(row!).toMatch(new RegExp(`^${mark} ${verdict} · integrate \\d+:\\d+ ✓ · final review \\d+:\\d+`))
    expect(colorOf(tree, `${mark} ${verdict}`)).toBe(color)
  })
}

const EL = { Box: 'Box', Text: 'Text', Raster: 'Raster' }

test('a replay axis marks the cursor with a diamond and a live axis says now', () => {
  const { s, f } = fixture()
  for (const width of [84, 110, 140]) {
    const span = flightSpan(s, f)
    const replay = lines(flightPlan(EL, s, f, { width, terminal: true, replay: true, span }) as unknown as Node)
    const axis = replay.filter(r => r.includes('◆'))
    expect(axis.length).toBe(1)
    expect(replay.some(r => /\bnow\b/.test(r))).toBe(false)
    const live = lines(flightPlan(EL, s, f, { width, terminal: true, replay: false }) as unknown as Node)
    expect(live.some(r => /\bnow\b/.test(r))).toBe(true)
    expect(live.some(r => r.includes('◆'))).toBe(false)
  }
  const tree = flightPlan(EL, s, f, { width: 110, terminal: true, replay: true }) as unknown as Node
  expect(colorOf(tree, '◆')).toBe(P.yellow)
})

test('the token count carries its unit and drops rather than cutting the status', () => {
  const { s, f } = fixture()
  const passed = lane('T1', 'passed', { startedAt: 0, endedAt: 271_000, tokens: 136_000 })
  const wide = lines(flightPlan(EL, { ...s, lanes: [passed] }, f, { width: 110, terminal: true, replay: false }) as unknown as Node)
  expect(wide.some(r => r.trimEnd().endsWith('136k out ✓ 4:31'))).toBe(true)
  for (const width of [60, 84]) {
    const narrow = lines(flightPlan(EL, { ...s, lanes: [passed] }, f, { width, terminal: true, replay: false }) as unknown as Node)
    const row = narrow.find(r => r.includes('✓ 4:31'))
    expect(row).toBeDefined()
    expect(row!).not.toContain('136k')
    expect(row!).not.toContain('out')
  }
  const failed = lane('T2', 'failed', { attempts: [attempt(1, 2, null, null, false)], tokens: 136_000 })
  const row = lines(flightPlan(EL, { ...s, lanes: [failed] }, f, { width: 110, terminal: true, replay: false }) as unknown as Node).find(r => r.includes('✗ 1/3'))
  expect(row).toBeDefined()
  expect(row!.trimEnd().endsWith('136k out ✗ 1/3')).toBe(true)
})

function texts(node: Node, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach(n => texts(n, out))
  else if (node && typeof node === 'object') {
    if (node.type === 'Text') out.push(node)
    texts(node.children as Node, out)
  }
  return out
}

test('every Text in the plan carries mono, nested ones too', () => {
  const { s, f } = fixture()
  for (const replay of [false, true]) {
    const found = texts(flightPlan(EL, s, f, { width: 110, terminal: true, replay }) as unknown as Node)
    expect(found.length).toBeGreaterThan(20)
    for (const t of found) expect((t as { props?: { mono?: unknown } }).props?.mono).toBe(true)
  }
})

function closed(verdict: string, finals = 1, extra: Partial<Sprint> = {}) {
  const { s, f } = fixture(130_000)
  const store = D.createStore()
  const integ = agent(store, 'i1', 'integrate (sonnet·high)', 90_000, 100_000, 'b')
  const fins = Array.from({ length: finals }, (_, i) => agent(store, `fr${i}`, 'final review (top·max)', 100_000, 110_000 + i * 20_000, 't'))
  const done: Sprint = { ...s, stage: 'done', at: 200_000, closers: [integ, ...fins], final: { verdict, summary: '' }, ...extra }
  return { done, f }
}

const heading = (s: Sprint, f: Forecast, width = 84) => lines(flightPlan(EL, s, f, { width, terminal: true, replay: false }) as unknown as Node)[0] ?? ''
const rowsOf = (s: Sprint, f: Forecast, width = 84) => lines(flightPlan(EL, s, f, { width, terminal: true, replay: false }) as unknown as Node)

test('a finished plan heading says when the run finished and how long it took', () => {
  const { s, f } = fixture(130_000)
  const top = heading({ ...s, stage: 'done', at: 130_000 + 5 * 60_000 }, f)
  expect(top).toContain('1 of 4 passed · finished 5m ago · took 2:10')
  expect(heading({ ...s, stage: 'done', at: 135_000 }, f)).toContain('finished just now · took 2:10')
  const live = fixture()
  expect(heading(live.s, live.f)).not.toContain('finished')
})

test('a fix round plan names the fix round in the heading, replay included', () => {
  const { s, f } = fixture()
  expect(heading({ ...s, round: 1 }, f)).toContain('fix round 1 · 1 of 4 passed')
  expect(heading({ ...s, round: 0 }, f)).not.toContain('fix round')
  const replay = lines(flightPlan(EL, { ...s, round: 2 }, f, { width: 84, terminal: true, replay: true, span: [0, 400_000] }) as unknown as Node)[0]
  expect(replay).toContain('fix round 2 · 2:00 of 6:40')
})

test('the decider line names the triage plan and each fix round plan', () => {
  const { s, f } = fixture()
  const store = D.createStore()
  const t = agent(store, 'fa', 'fix plan (top·high)', 100_000, 105_000, 'q')
  const r1 = agent(store, 'fb', 'fix plan (top·high)', 106_000, 110_000, 'q')
  const r2 = agent(store, 'fc', 'fix plan (top·high)', 111_000, 119_000, 'q')
  const decider = (round: number, deciders: AgentRow[]) => rowsOf({ ...s, round, deciders }, f).find(l => l.includes('plan ')) ?? ''
  const two = decider(2, [...s.deciders, t, r1, r2])
  expect(two).toContain('triage 0:05 ✓ · fix round 1 plan 0:04 ✓ · fix round 2 plan 0:08 ✓')
  expect(two).not.toMatch(/fix plan/)
  const one = decider(1, [...s.deciders, t, r1])
  expect(one).toContain('triage 0:05 ✓ · fix round 1 plan 0:04 ✓')
  expect(decider(0, [...s.deciders, t])).toContain('triage 0:05 ✓')
})

test('the closing line starts with the verdict and keeps it whole at 48 columns', () => {
  for (const verdict of ['fix first', 'block']) {
    const { done, f } = closed(verdict)
    for (const width of [48, 60, 84]) {
      const row = rowsOf(done, f, width).find(l => l.includes('integrate') && l.includes('✗'))
      expect(row).toBeDefined()
      expect(row!.startsWith(`✗ ${verdict} · integrate `)).toBe(true)
      expect([...row!].length).toBeLessThanOrEqual(width)
    }
  }
  const { done, f } = closed('ship')
  expect(rowsOf(done, f, 48).some(l => l.startsWith('✓ ship · integrate 0:10 ✓ · final review'))).toBe(true)
})

test('the closing line ends with what the previous round said', () => {
  const { done, f } = closed('ship')
  const last = (round: number, verdict: string) => rowsOf({ ...done, round, previous: { verdict, summary: '' } }, f).find(l => l.includes('final review')) ?? ''
  expect(last(1, 'fix first')).toMatch(/final review 0:10 · the first round said fix first$/)
  expect(last(2, 'block')).toMatch(/· fix round 1 said block$/)
  const none = rowsOf({ ...done, round: 1, previous: null }, f).find(l => l.includes('final review')) ?? ''
  expect(none).not.toContain('said')
  expect(last(0, 'ship')).not.toContain('said')
})

test('several final reviewers read as one review with the longest time', () => {
  const { done, f } = closed('ship', 3)
  const row = rowsOf(done, f).find(l => l.includes('final review')) ?? ''
  expect(row).toContain('final review ×3 0:50')
  const one = closed('ship', 1)
  expect(rowsOf(one.done, one.f).find(l => l.includes('final review'))).not.toContain('×')
})

function height(n: Node): number {
  if (Array.isArray(n)) return n.reduce((sum: number, c: Node) => sum + height(c), 0)
  if (!n || typeof n !== 'object') return 0
  const props = (n.props ?? {}) as { flexDirection?: string; rows?: number }
  if (n.type === 'Text') return words(n).join('').length > 0 ? 1 : 0
  if (n.type === 'Raster') return props.rows ?? 0
  const kids = Array.isArray(n.children) ? (n.children as Node[]) : [n.children as Node]
  const sizes = kids.map(height)
  return props.flexDirection === 'row' ? Math.max(0, ...sizes) : sizes.reduce((a, b) => a + b, 0)
}

test('a replayed plan keeps the rows of the un-replayed plan when steady is given', () => {
  const { s: base, f } = fixture()
  const more = ['T5'].map(id => lane(id, 'waiting', { dependsOn: ['T1'] }))
  const steady: Sprint = { ...base, lanes: [...base.lanes, ...more] }
  expect(steady.lanes.length).toBe(5)
  const subset: Sprint = { ...steady, lanes: steady.lanes.slice(0, 3) }
  const bare: Sprint = { ...steady, lanes: [], deciders: [] }
  for (const terminal of [true, false]) {
    for (const width of [48, 60, 84, 110, 140]) {
      const span = flightSpan(steady, f)
      const want = height(flightPlan(EL, steady, f, { width, terminal, replay: false }) as unknown as Node)
      for (const s of [subset, bare]) {
        const got = height(flightPlan(EL, s, f, { width, terminal, replay: true, span, steady }) as unknown as Node)
        expect([width, terminal, s === bare, got]).toEqual([width, terminal, s === bare, want])
        const without = height(flightPlan(EL, s, f, { width, terminal, replay: true, span }) as unknown as Node)
        expect(without).toBeLessThan(want)
      }
    }
  }
})
