import type { Forecast, Lane, LaneStatus, Sprint } from '../types'
import type { El } from './art'
import { Canvas, hex, mix, paint } from './art'
import { P, rule } from './look'

type Pos = { x: number; y: number }

type Plan = {
  depth: Map<string, number>
  deps: Map<string, string[]>
  layers: Lane[][]
  widths: number[]
  maxNodeW: number
  free: number
}

const DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

const STATUS_COLOR: Record<LaneStatus, string> = {
  passed: P.green,
  failed: P.red,
  building: P.blue,
  reviewing: P.mauve,
  ready: P.text,
  waiting: P.over0,
  skipped: P.surf2,
}

function shown(id: string): string {
  let out = ''
  for (const ch of id.slice(0, 5)) {
    const c = ch.codePointAt(0) ?? 0
    out += c > 0x20 && c < 0x7f ? ch : '?'
  }
  return out
}

function nodeW(id: string): number {
  return 1 + shown(id).length
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function plan(s: Sprint, cols: number, rows: number): Plan {
  const byId = new Map(s.lanes.map(l => [l.id, l]))
  const depth = new Map<string, number>()
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): number => {
    const seen = state.get(id)
    if (seen === 2) return depth.get(id) ?? 0
    if (seen === 1) return -1
    state.set(id, 1)
    let d = 0
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue
      const dd = visit(dep)
      if (dd >= 0) d = Math.max(d, dd + 1)
    }
    state.set(id, 2)
    depth.set(id, d)
    return d
  }
  for (const l of s.lanes) visit(l.id)
  const deps = new Map<string, string[]>()
  for (const l of s.lanes) {
    const mine = depth.get(l.id) ?? 0
    deps.set(
      l.id,
      [...new Set(l.dependsOn)].filter(d => d !== l.id && byId.has(d) && (depth.get(d) ?? 0) < mine),
    )
  }
  const layers: Lane[][] = []
  for (const l of s.lanes) {
    const d = depth.get(l.id) ?? 0
    while (layers.length <= d) layers.push([])
    layers[d]!.push(l)
  }
  const maxNodeW = s.lanes.reduce((m, l) => Math.max(m, nodeW(l.id)), 1)
  const r = Math.max(1, rows)
  const widths = layers.map(layer => Math.ceil(layer.length / r) * (maxNodeW + 1) - 1)
  const free = cols - 6 - widths.reduce((a, b) => a + b, 0)
  return { depth, deps, layers, widths, maxNodeW, free }
}

function mapRows(s: Sprint): number {
  return clamp(Math.max(0, ...plan(s, 0, 1).layers.map(l => l.length)), 3, 8)
}

export function skyLayout(s: Sprint, cols: number, rows: number): Map<string, Pos> {
  const p = plan(s, cols, rows)
  const r = Math.max(1, rows)
  const out = new Map<string, Pos>()
  const L = p.layers.length
  const gap = L > 1 ? Math.max(0, Math.floor(p.free / (L - 1))) : 0
  let x = 0
  p.layers.forEach((layer, i) => {
    const order = layer.map((l, k) => {
      const ys = (p.deps.get(l.id) ?? []).map(d => out.get(d)?.y ?? 0)
      return { l, k, mean: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : -1 }
    })
    if (i > 0) order.sort((a, b) => a.mean - b.mean || a.k - b.k)
    const sub = Math.max(1, Math.ceil(layer.length / r))
    for (let c = 0; c < sub; c++) {
      const col = order.filter((_, k) => k % sub === c)
      col.forEach(({ l }, j) => {
        out.set(l.id, { x: x + c * (p.maxNodeW + 1), y: Math.floor(((j + 0.5) * r) / col.length) })
      })
    }
    x += (p.widths[i] ?? 0) + gap
  })
  out.set('ship', { x: cols - 5, y: Math.floor(rows / 2) })
  return out
}

export function skyFits(s: Sprint, width: number): boolean {
  if (s.lanes.length < 2 || width < 56) return false
  const p = plan(s, width, mapRows(s))
  return p.free >= 2 * (p.layers.length - 1)
}

function shipColor(s: Sprint): string {
  if (s.final && s.final.verdict !== 'ship') return P.red
  if (s.final?.verdict === 'ship' && s.stage === 'done') return P.green
  if (s.stage === 'integrating' || s.stage === 'reviewing') return P.blue
  return P.surf2
}

export function skyCanvas(s: Sprint, f: Forecast, cols: number, rows: number): Canvas {
  const canvas = new Canvas(cols, rows)
  const pos = skyLayout(s, cols, rows)
  const p = plan(s, cols, rows)
  const critical = new Set(f.criticalPath)
  for (const [id, pr] of Object.entries(f.projections)) if (pr.critical) critical.add(id)
  const status = new Map(s.lanes.map(l => [l.id, l.status]))

  const node = new Uint8Array(cols * rows)
  const claim = (x: number, y: number, w: number) => {
    for (let i = 0; i < w; i++) if (x + i >= 0 && x + i < cols && y >= 0 && y < rows) node[y * cols + x + i] = 1
  }
  for (const l of s.lanes) {
    const at = pos.get(l.id)
    if (at) claim(at.x, at.y, nodeW(l.id))
  }
  const ship = pos.get('ship')!
  claim(ship.x, ship.y, 5)

  const bits = new Uint8Array(cols * rows)
  const rank = new Uint8Array(cols * rows)
  const tone = [0, hex(P.surf2), mix(hex(P.green), 0x1e1e2e, 0.4), hex(P.peach)]
  const edge = (from: string, to: string, level: number) => {
    const a = pos.get(from)
    const b = pos.get(to)
    if (!a || !b) return
    const x0 = 2 * (a.x + nodeW(from))
    const y0 = 4 * a.y + 2
    const x3 = 2 * b.x - 1
    const y3 = 4 * b.y + 2
    const h = (x3 - x0) / 2
    const n = 2 * (Math.abs(x3 - x0) + Math.abs(y3 - y0)) + 1
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0
      const u = 1 - t
      const X = Math.round(u * u * u * x0 + 3 * u * u * t * (x0 + h) + 3 * u * t * t * (x3 - h) + t * t * t * x3)
      const Y = Math.round(u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y3 + t * t * t * y3)
      if (X < 0 || Y < 0) continue
      const cx = Math.floor(X / 2)
      const cy = Math.floor(Y / 4)
      if (cx >= cols || cy >= rows) continue
      const c = cy * cols + cx
      if (node[c]) continue
      bits[c] = (bits[c] ?? 0) | (DOTS[Y % 4]![X % 2] ?? 0)
      if (level > (rank[c] ?? 0)) rank[c] = level
    }
  }
  const levelOf = (from: string, crit: boolean) => (crit ? 3 : status.get(from) === 'passed' ? 2 : 1)
  const fed = new Set<string>()
  for (const l of s.lanes) {
    for (const d of p.deps.get(l.id) ?? []) {
      fed.add(d)
      edge(d, l.id, levelOf(d, critical.has(d) && critical.has(l.id)))
    }
  }
  for (const l of s.lanes) if (!fed.has(l.id)) edge(l.id, 'ship', levelOf(l.id, critical.has(l.id)))

  for (let c = 0; c < cols * rows; c++) {
    const b = bits[c] ?? 0
    if (b) canvas.put(c % cols, Math.floor(c / cols), 0x2800 + b, tone[rank[c] ?? 1] ?? tone[1]!)
  }

  const odd = Math.floor(s.at / 1000) % 2 === 1
  for (const l of s.lanes) {
    const at = pos.get(l.id)
    if (!at) continue
    const glyph = l.id === f.longPole && odd ? '▓' : '█'
    canvas.put(at.x, at.y, glyph, hex(STATUS_COLOR[l.status] ?? P.over0))
    canvas.text(at.x + 1, at.y, shown(l.id), hex(critical.has(l.id) ? P.peach : P.sub0))
  }
  canvas.text(ship.x, ship.y, '█ship', hex(shipColor(s)))
  return canvas
}

function chain(path: string[]): string {
  if (path.length <= 4) return path.join(' → ')
  return `${path[0]} → … → ${path[path.length - 1]}`
}

export function skyMap(el: El, s: Sprint, f: Forecast, o: { width: number; terminal: boolean; steady?: Sprint }) {
  if (!skyFits(o.steady ?? s, o.width)) return null
  const { Box, Text } = el
  const rows = mapRows(o.steady ?? s)
  const n = s.lanes.length
  const info = s.draft
    ? 'draft · the critic is checking it'
    : `${n} ticket${n === 1 ? '' : 's'}${f.criticalPath.length ? ` · longest chain ${chain(f.criticalPath)}` : ''}`
  return (
    <Box key={`sky-${s.runId}`} flexDirection="column">
      {rule(el, o.width, 'SPRINT MAP', info)}
      {skyFits(s, o.width)
        ? paint(el, skyCanvas(s, f, o.width, rows), 'sky-map', o.terminal)
        : Array.from({ length: rows }, () => <Text mono> </Text>)}
    </Box>
  )
}
