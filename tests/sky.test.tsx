import { expect, test } from 'claude-code/testing'

import type { Forecast, Lane, LaneStatus, Sprint } from '../types'
import { hex } from '../hooks/art'
import { P } from '../hooks/look'
import { skyCanvas, skyFits, skyLayout, skyMap } from '../hooks/sky'

const lane = (id: string, dependsOn: string[] = [], status: LaneStatus = 'waiting'): Lane => ({
  id,
  title: `ticket ${id}`,
  kind: 'routine',
  dependsOn,
  estimateMin: 4,
  status,
  attempts: [],
  maxAttempts: 3,
  startedAt: null,
  endedAt: null,
  tokens: 0,
  live: null,
})

const sprint = (lanes: Lane[], over: Partial<Sprint> = {}): Sprint => ({
  tokens: 0,
  previous: null,
  runId: 'wf_sky',
  name: 'sprint',
  startedAt: 0,
  endedAt: null,
  at: 60_000,
  round: 0,
  stage: 'building',
  draft: false,
  lanes,
  deciders: [],
  closers: [],
  final: null,
  ...over,
})

const forecast = (criticalPath: string[] = [], longPole: string | null = null): Forecast => ({
  at: 60_000,
  factor: 1,
  projections: {},
  criticalPath,
  longPole,
  waiting: [],
  buildEnd: null,
  eta: null,
})

// T1 -> T2 -> T4, T1 -> T3 -> T4, T5 alone; layer 1 holds T2, T3 and the late T6.
const GRAPH = () =>
  sprint([
    lane('T1', [], 'passed'),
    lane('T2', ['T1'], 'building'),
    lane('T3', ['T1'], 'reviewing'),
    lane('T4', ['T2', 'T3']),
    lane('T5', [], 'ready'),
    lane('T6', ['T5']),
  ])

const many = (n: number) => sprint(Array.from({ length: n }, (_, i) => lane(`T${i + 1}`)))

function cell(c: ReturnType<typeof skyCanvas>, x: number, y: number) {
  const i = (y * c.cols + x) * 3
  return { ch: c.words[i] ?? 0x20, fg: c.words[i + 1] ?? 0 }
}

function rowText(c: ReturnType<typeof skyCanvas>, y: number): string {
  let s = ''
  for (let x = 0; x < c.cols; x++) s += String.fromCodePoint(cell(c, x, y).ch)
  return s
}

function noOverlap(s: Sprint, pos: Map<string, { x: number; y: number }>, cols: number, rows: number) {
  const taken = new Set<string>()
  for (const [id, p] of pos) {
    const w = id === 'ship' ? 5 : 1 + id.slice(0, 5).length
    expect(p.x >= 0 && p.y >= 0 && p.x + w <= cols && p.y < rows).toBe(true)
    for (let i = 0; i < w; i++) {
      const k = `${p.x + i},${p.y}`
      expect(taken.has(k)).toBe(false)
      taken.add(k)
    }
  }
  expect(pos.size).toBe(s.lanes.length + 1)
}

test('dependents sit to the right of their dependencies, ship rightmost', () => {
  const s = GRAPH()
  const pos = skyLayout(s, 84, 4)
  for (const l of s.lanes) for (const d of l.dependsOn) expect(pos.get(l.id)!.x).toBeGreaterThan(pos.get(d)!.x)
  expect(pos.get('ship')).toEqual({ x: 79, y: 2 })
  for (const l of s.lanes) expect(pos.get(l.id)!.x).toBeLessThan(79)
})

test('every id and ship appear as consecutive cells', () => {
  const s = GRAPH()
  const c = skyCanvas(s, forecast(), 84, 4)
  const pos = skyLayout(s, 84, 4)
  for (const [id, p] of pos) {
    const want = id === 'ship' ? '█ship' : id
    const at = id === 'ship' ? p.x : p.x + 1
    expect(rowText(c, p.y).slice(at, at + want.length)).toBe(want)
  }
})

test('nodes never overlap and stay inside the canvas', () => {
  const s = GRAPH()
  noOverlap(s, skyLayout(s, 84, 4), 84, 4)
  noOverlap(s, skyLayout(s, 60, 3), 60, 3)
})

test('20 independent tickets fit at 84 by 6 using sub-columns', () => {
  const s = many(20)
  const pos = skyLayout(s, 84, 6)
  noOverlap(s, pos, 84, 6)
  const xs = new Set(s.lanes.map(l => pos.get(l.id)!.x))
  expect(xs.size).toBe(4)
  expect(skyFits(s, 84)).toBe(true)
})

test('a split layer in a multi-layer graph stays clear of its neighbours', () => {
  const roots = Array.from({ length: 4 }, (_, i) => lane(`R${i}`))
  const mid = Array.from({ length: 11 }, (_, i) => lane(`M${i}`, [`R${i % 4}`]))
  const s = sprint([...roots, ...mid, lane('Z', ['M0', 'M5'])])
  const pos = skyLayout(s, 84, 8)
  noOverlap(s, pos, 84, 8)
  expect(new Set(mid.map(l => pos.get(l.id)!.x)).size).toBe(2)
  for (const l of s.lanes) for (const d of l.dependsOn) expect(pos.get(l.id)!.x).toBeGreaterThan(pos.get(d)!.x)
  expect(skyFits(s, 84)).toBe(true)
})

test('a cycle does not hang and still lays out', () => {
  const s = sprint([lane('A', ['B']), lane('B', ['A']), lane('C', ['C'])])
  const pos = skyLayout(s, 60, 3)
  noOverlap(s, pos, 60, 3)
})

test('braille cells lie between connected nodes', () => {
  const s = sprint([lane('A'), lane('B', ['A'])])
  const c = skyCanvas(s, forecast(), 60, 3)
  const pos = skyLayout(s, 60, 3)
  const a = pos.get('A')!
  const b = pos.get('B')!
  let between = 0
  for (let x = a.x + 2; x < b.x; x++) {
    const ch = cell(c, x, a.y).ch
    if (ch > 0x2800 && ch <= 0x28ff) between++
  }
  expect(between).toBeGreaterThan(0)
  expect(between).toBe(b.x - a.x - 2)
})

test('a passed node is green and critical edges are peach', () => {
  const s = sprint([lane('A', [], 'passed'), lane('B', ['A']), lane('C', [], 'failed')])
  const c = skyCanvas(s, forecast(['A', 'B']), 60, 3)
  const pos = skyLayout(s, 60, 3)
  const a = pos.get('A')!
  expect(cell(c, a.x, a.y).fg).toBe(hex(P.green))
  expect(cell(c, a.x + 1, a.y).fg).toBe(hex(P.peach))
  const cc = pos.get('C')!
  expect(cell(c, cc.x, cc.y).fg).toBe(hex(P.red))
  expect(cell(c, cc.x + 1, cc.y).fg).toBe(hex(P.sub0))
  const b = pos.get('B')!
  expect(cell(c, b.x - 1, b.y).fg).toBe(hex(P.peach))
  expect(cell(c, b.x + 2, b.y).fg).toBe(hex(P.peach))
  expect(cell(c, cc.x + 3, cc.y).fg).toBe(hex(P.surf2))
})

test('the long pole flickers between full and shaded blocks', () => {
  const s = sprint([lane('A'), lane('B')], { at: 1000 })
  const pos = skyLayout(s, 60, 3)
  const a = pos.get('A')!
  expect(String.fromCodePoint(cell(skyCanvas(s, forecast([], 'A'), 60, 3), a.x, a.y).ch)).toBe('▓')
  expect(String.fromCodePoint(cell(skyCanvas({ ...s, at: 2000 }, forecast([], 'A'), 60, 3), a.x, a.y).ch)).toBe('█')
})

test('ship takes the final verdict colour', () => {
  const s = sprint([lane('A', [], 'passed'), lane('B', [], 'passed')])
  const ship = skyLayout(s, 60, 3).get('ship')!
  const fg = (o: Partial<Sprint>) => cell(skyCanvas({ ...s, ...o }, forecast(), 60, 3), ship.x, ship.y).fg
  expect(fg({ stage: 'done', final: { verdict: 'ship', summary: '' } })).toBe(hex(P.green))
  expect(fg({ stage: 'done', final: { verdict: 'block', summary: '' } })).toBe(hex(P.red))
  expect(fg({ stage: 'integrating' })).toBe(hex(P.blue))
  expect(fg({ stage: 'building' })).toBe(hex(P.surf2))
})

test('the same input always gives the same cells', () => {
  const s = GRAPH()
  const f = forecast(['T1', 'T2', 'T4'], 'T2')
  expect(Array.from(skyCanvas(s, f, 84, 4).words)).toEqual(Array.from(skyCanvas(s, f, 84, 4).words))
})

test('every code point is ASCII, a block element or braille', () => {
  for (const [s, cols, rows] of [
    [GRAPH(), 84, 4],
    [many(20), 84, 6],
  ] as const) {
    const c = skyCanvas(s, forecast(['T1', 'T2', 'T4'], 'T1'), cols, rows)
    for (let i = 0; i < cols * rows; i++) {
      const ch = c.words[i * 3] ?? 0
      const ok = (ch >= 0x20 && ch < 0x7f) || (ch >= 0x2580 && ch <= 0x259f) || (ch >= 0x2800 && ch <= 0x28ff)
      expect(ok).toBe(true)
    }
  }
})

const EL = { Box: 'Box', Text: 'Text', Raster: 'Raster' }

test('skyFits is false for one lane or a width of 50', () => {
  expect(skyFits(sprint([lane('A')]), 84)).toBe(false)
  expect(skyFits(GRAPH(), 50)).toBe(false)
  expect(skyFits(GRAPH(), 84)).toBe(true)
  expect(skyMap(EL, sprint([lane('A')]), forecast(), { width: 84, terminal: true })).toBe(null)
  expect(skyMap(EL, GRAPH(), forecast(), { width: 50, terminal: false })).toBe(null)
})

test('skyMap is a Box keyed by run with the map title and longest chain', () => {
  const f = forecast(['T1', 'T2', 'T4'])
  const term = skyMap(EL, GRAPH(), f, { width: 84, terminal: true }) as never as { props: { key: string } }
  expect(term.props.key).toBe('sky-wf_sky')
  const flat = JSON.stringify(term)
  expect(flat.includes('SPRINT MAP')).toBe(true)
  expect(flat.includes('6 tickets · longest chain T1 → T2 → T4')).toBe(true)
  expect(flat.includes('"Raster"')).toBe(true)
  const long = forecast(['T1', 'T2', 'T3', 'T4', 'T6'])
  expect(JSON.stringify(skyMap(EL, GRAPH(), long, { width: 84, terminal: false })).includes('T1 → … → T6')).toBe(true)
  const desk = JSON.stringify(skyMap(EL, GRAPH(), f, { width: 84, terminal: false }))
  expect(desk.includes('"Raster"')).toBe(false)
  expect(desk.includes('ship')).toBe(true)
  expect(JSON.stringify(skyMap(EL, GRAPH(), f, { width: 60, terminal: false })).includes('SPRINT MAP')).toBe(true)
  const d = JSON.stringify(skyMap(EL, { ...GRAPH(), draft: true }, f, { width: 84, terminal: false }))
  expect(d.includes('draft · the critic is checking it')).toBe(true)
})

function mapHeight(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  const n = node as { type?: unknown; props?: { rows?: number }; children?: unknown[] }
  if (n.type === 'Raster') return n.props?.rows ?? 0
  if (n.type === 'Text') return 1
  return (n.children ?? []).flat(Infinity).reduce<number>((a, k) => a + mapHeight(k), 0)
}

test('a replayed map keeps the height of the un-replayed map for all, one or no lanes', () => {
  // GRAPH is no wider than the three-row minimum; five tickets side by side are wider, so a replay of one of
  // them would draw fewer rows unless the map is sized from the un-replayed sprint.
  for (const steady of [GRAPH(), many(5)]) {
    const f = forecast()
    for (const width of [84, 110]) {
      expect(skyFits(steady, width)).toBe(true)
      for (const terminal of [true, false]) {
        const base = skyMap(EL, steady, f, { width, terminal })
        const want = mapHeight(base)
        expect(want).toBeGreaterThan(1)
        for (const lanes of [steady.lanes, steady.lanes.slice(0, 1), []]) {
          const replayed = { ...steady, lanes }
          const drawn = skyMap(EL, replayed, f, { width, terminal, steady })
          expect(drawn).not.toBe(null)
          expect(mapHeight(drawn), `${steady.lanes.length} lanes replayed as ${lanes.length} at ${width}`).toBe(want)
        }
      }
    }
  }
  expect(skyMap(EL, GRAPH(), forecast(), { width: 50, terminal: true, steady: GRAPH() })).toBe(null)
})
