import type { AgentRow, Attempt, Code, Forecast, Lane, Sprint } from '../types'
import type { El } from './art'
import { Canvas, hex, paint } from './art'
import * as D from './deck'
import { fit, len, P, rule, STATE } from './look'

type Seg = [text: string, color: string, bold?: boolean]

const ID_W = 5
const PIPS = '▁▂▄▆█'
const DONE = new Set(['passed', 'failed', 'skipped'])

export type FlightColumns = { idW: number; titleW: number; pipsW: number; rightW: number; strip: number }

// Where each part of a flight-plan row goes: two for the glyph and its space, then id, title,
// tier pips, the strip, and the time column. The parts add up to the width from 40 columns.
export function flightColumns(width: number): FlightColumns {
  let titleW = width >= 100 ? Math.min(40, 24 + Math.floor((width - 100) / 2)) : width >= 84 ? 18 : width >= 70 ? 14 : 10
  let pipsW = width >= 70 ? 4 : 0
  const rightW = width >= 100 ? 16 : 10
  const room = () => width - 2 - ID_W - (titleW + 1) - pipsW - (rightW + 1)
  let strip = room()
  if (strip < 8) {
    pipsW = 0
    titleW = 8
    strip = Math.max(0, room())
  }
  return { idW: ID_W, titleW, pipsW, rightW, strip }
}

// The time axis: the strip starts at the first ticket, so the width goes to the work and not to
// planning (the back button and the left arrow reach planning before it; labels stay relative to the
// run's start). Until a ticket has started it starts at the run's start. It ends at the finish while
// the run is over, at the build-end estimate while deciding or building, otherwise at the finish
// estimate, and never less than a minute after its start.
export function flightSpan(s: Sprint, f: Forecast): [number, number] {
  let from = Infinity
  for (const lane of s.lanes) if (lane.startedAt !== null && lane.startedAt < from) from = lane.startedAt
  if (from === Infinity) from = s.startedAt
  const building = s.stage === 'deciding' || s.stage === 'building'
  const to = s.endedAt ?? Math.max(building ? f.buildEnd ?? s.at : f.eta ?? s.at, s.at)
  return [from, Math.max(to, from + 60_000)]
}

function nowCol(s: Sprint, from: number, to: number, cols: number): number | null {
  if (s.endedAt !== null || cols <= 0) return null
  const x = Math.floor(((s.at - from) / Math.max(1, to - from)) * cols)
  if (x < 0) return null
  if (x >= cols) return s.at <= to ? cols - 1 : null
  return x
}

function glyphOf(code: Code | null, fg: number | null, canvas: Canvas, x: number, y: number, review: boolean) {
  if (code === null) return
  canvas.put(x, y, review ? 0x2580 : code === 'i' ? 0x2581 : 0x2584, fg ?? hex(STATE[code]))
}

function history(canvas: Canvas, y: number, row: AgentRow | null, s: Sprint, from: number, to: number, review: boolean, verdict: Attempt['verdict']) {
  if (!row) return
  const cols = canvas.cols
  const span = Math.max(1, to - from)
  const codes = D.cells(row, from, to, cols, s.at)
  const fixed = review && verdict ? hex(verdict.pass ? P.green : P.red) : null
  for (let c = 0; c < cols; c++) {
    if (from + ((c + 1) * span) / cols > s.at) break
    glyphOf(codes[c] ?? null, fixed, canvas, c, y, review)
  }
}

// One row per ticket: what each try did (builds low, reviews high), what is projected ahead of
// now, and a band at now while the sprint is live.
export function flightCanvas(s: Sprint, f: Forecast, from: number, to: number, cols: number): Canvas {
  const canvas = new Canvas(cols, s.lanes.length)
  const span = Math.max(1, to - from)
  s.lanes.forEach((lane, y) => {
    for (const a of lane.attempts) history(canvas, y, a.build, s, from, to, false, null)
    for (const a of lane.attempts) history(canvas, y, a.review, s, from, to, true, a.verdict)
    const p = f.projections[lane.id]
    if (p && !DONE.has(lane.status)) {
      const fg = hex(p.critical ? P.peach : P.surf2)
      for (let c = 0; c < cols; c++) {
        const t0 = from + (c * span) / cols
        const t1 = from + ((c + 1) * span) / cols
        if (t0 >= s.at && t1 > p.start && t0 < p.finish) canvas.put(c, y, 0x2591, fg)
      }
    }
  })
  const now = nowCol(s, from, to, cols)
  if (now !== null) {
    const bg = hex(P.surf1)
    for (let y = 0; y < s.lanes.length; y++) canvas.words[(y * cols + now) * 3 + 2] = bg
  }
  return canvas
}

function line(el: El, segs: Seg[], width: number) {
  const { Text } = el
  const out: Seg[] = []
  let left = Math.max(0, width)
  for (const [text, color, bold] of segs) {
    if (left <= 0) break
    const chars = [...text]
    const keep = chars.length > left ? chars.slice(0, left).join('') : text
    left -= Math.min(chars.length, left)
    out.push([keep, color, bold])
  }
  return (
    <Text mono wrap="truncate-end">
      {out.map(([text, color, bold]) => (bold ? <Text mono color={color} weight="bold">{text}</Text> : <Text mono color={color}>{text}</Text>))}
    </Text>
  )
}

function glyphFor(lane: Lane): [string, string] {
  switch (lane.status) {
    case 'passed': return ['✓', P.green]
    case 'failed': return ['✗', P.red]
    case 'building': return ['●', P.blue]
    case 'reviewing': return ['●', P.mauve]
    case 'ready': return ['◌', P.text]
    case 'skipped': return ['–', P.surf2]
    default: return ['○', P.over0]
  }
}

function pipsFor(lane: Lane, pipsW: number): Seg[] {
  if (pipsW <= 0) return []
  const live = lane.status === 'building' || lane.status === 'reviewing'
  const last = lane.attempts.length - 1
  const shown = lane.attempts.slice(-Math.min(3, pipsW))
  const segs: Seg[] = shown.map((a, i) => {
    const rung = a.rung < 0 ? 0 : Math.min(4, a.rung)
    const color = a.verdict ? (a.verdict.pass ? P.green : P.red) : live && lane.attempts.length - shown.length + i === last ? P.blue : P.over0
    return [PIPS.charAt(a.rung < 0 ? 0 : rung), color]
  })
  segs.push([' '.repeat(pipsW - shown.length), P.over0])
  return segs
}

function attemptStart(lane: Lane, at: number): number {
  const a = lane.attempts[lane.attempts.length - 1]
  const starts = [a?.build?.startedAt, a?.review?.startedAt].filter((t): t is number => typeof t === 'number')
  if (starts.length) return Math.min(...starts)
  return lane.live?.startedAt ?? lane.startedAt ?? at
}

function rightOf(lane: Lane, s: Sprint, f: Forecast, rightW: number): [string, string] {
  const p = f.projections[lane.id]
  let text: string
  let color = P.sub0
  switch (lane.status) {
    case 'passed':
      text = `✓ ${D.clock((lane.endedAt ?? s.at) - (lane.startedAt ?? s.at))}`
      color = P.green
      break
    case 'failed': {
      const full = `✗ ${lane.attempts.length}/${lane.maxAttempts} tries`
      text = len(full) <= rightW - (lane.tokens > 0 ? len(D.tokens(lane.tokens)) + 5 : 0) ? full : `✗ ${lane.attempts.length}/${lane.maxAttempts}`
      color = P.red
      break
    }
    case 'building':
    case 'reviewing': {
      const took = Math.max(0, s.at - attemptStart(lane, s.at))
      const left = p ? ` ~${Math.max(1, Math.round((p.finish - s.at) / 60_000))}m` : ''
      text = `${D.clock(took)}${left}`
      const budget = lane.estimateMin * 60_000 * f.factor
      color = took > 2 * budget ? P.red : took > budget ? P.yellow : lane.status === 'building' ? P.blue : P.mauve
      break
    }
    case 'ready':
      text = 'next'
      color = P.text
      break
    case 'skipped':
      text = 'skipped'
      color = P.surf2
      break
    default:
      text = `after ${p?.after ?? lane.dependsOn[0] ?? '?'}`
      color = P.over0
  }
  if (lane.tokens > 0) {
    const withTokens = `${D.tokens(lane.tokens)} out ${text}`
    if (len(withTokens) <= rightW) text = withTokens
  }
  return [fit(text, rightW), color]
}

function deciderLine(el: El, s: Sprint, width: number) {
  const segs: Seg[] = []
  const fixPlans = s.deciders.filter(r => r.label.startsWith('fix plan ('))
  const firstRound = fixPlans.length - Math.min(s.round, fixPlans.length)
  for (const row of s.deciders) {
    if (segs.length) segs.push([' · ', P.surf2])
    let name = row.label.startsWith('plan critic') ? 'critic' : row.label.split(' ')[0] ?? row.label
    if (row.label.startsWith('fix plan (')) {
      const at = fixPlans.indexOf(row)
      name = at < firstRound ? 'triage' : `fix round ${at - firstRound + 1} plan`
    }
    const over = row.endedAt !== null && row.endedAt <= s.at
    segs.push([`${name} `, P.over0])
    if (over) segs.push([`${D.clock((row.endedAt ?? s.at) - row.startedAt)} `, P.over0], row.outcome === 'done' || row.outcome === null ? ['✓', P.green] : ['✗', P.red])
    else segs.push(['●', P.blue], [` ${D.clock(Math.max(0, s.at - row.startedAt))}`, P.over0])
  }
  return line(el, segs, width)
}

function closerLine(el: El, s: Sprint, width: number) {
  const said: Seg[] = s.round > 0 && s.previous ? [[` · ${s.round === 1 ? 'the first round' : `fix round ${s.round - 1}`} said ${s.previous.verdict}`, P.over0]] : []
  if (s.closers.length === 0) return line(el, [['integrate and final review next', P.over0], ...said], width)
  const segs: Seg[] = []
  if (s.final) segs.push(s.final.verdict === 'ship' ? ['✓ ship', P.green, true] : [`✗ ${s.final.verdict}`, P.red, true], [' · ', P.surf2])
  const finals = s.closers.filter(r => r.label.startsWith('final review'))
  const parts: [string, AgentRow[]][] = [
    ['integrate', s.closers.filter(r => r.label.startsWith('integrate')).slice(-1)],
    ['final review', finals],
  ]
  let first = true
  for (const [name, rows] of parts) {
    if (!first) segs.push([' · ', P.surf2])
    first = false
    if (rows.length === 0) {
      segs.push([`${name} next`, P.over0])
      continue
    }
    const isOver = (r: AgentRow) => r.endedAt !== null && r.endedAt <= s.at
    const live = rows.some(r => !isOver(r))
    const took = Math.max(...rows.map(r => Math.max(0, (isOver(r) ? r.endedAt ?? s.at : s.at) - r.startedAt)))
    segs.push([`${rows.length > 1 ? `${name} ×${rows.length}` : name} ${D.clock(took)}`, P.over0])
    if (live) segs.push([' ●', P.blue])
    else if (name === 'final review' && s.final) continue
    else {
      const bad = rows.some(r => r.outcome === 'failed' || r.outcome === 'stopped')
      segs.push([bad ? ' ✗' : ' ✓', bad ? P.red : P.green])
    }
  }
  return line(el, [...segs, ...said], width)
}

function axisLine(el: El, s: Sprint, span: [number, number], width: number, cols: FlightColumns, replay: boolean) {
  const offset = width - cols.strip - (cols.rightW + 1)
  const startL = D.clock(span[0] - s.startedAt)
  const endL = D.clock(span[1] - s.startedAt)
  const cells = Array<string>(cols.strip).fill(' ')
  const put = (x: number, text: string) => [...text].forEach((ch, i) => { if (x + i >= 0 && x + i < cells.length) cells[x + i] = ch })
  const endX = cols.strip - len(endL)
  const both = endX >= len(startL) + 1
  put(0, startL)
  if (both) put(endX, endL)
  else put(Math.max(0, endX), endL)
  const nx = nowCol(s, span[0], span[1], cols.strip)
  let px = -1
  if (nx !== null) {
    const w = replay ? 1 : 3
    const x = replay ? nx : Math.min(Math.max(0, nx - 1), cols.strip - 3)
    if (x >= len(startL) + 1 && x + w <= endX - 1) px = x
  }
  const mark = replay ? '◆' : 'now'
  if (px >= 0) put(px, mark)
  const text = cells.join('')
  const segs: Seg[] = [[' '.repeat(Math.max(0, offset)), P.over0]]
  if (px >= 0) segs.push([text.slice(0, px), P.over0], replay ? [mark, P.yellow, true] : [mark, P.lavender, true], [text.slice(px + mark.length), P.over0])
  else segs.push([text, P.over0])
  return line(el, segs, width)
}

function legendLine(el: El, width: number) {
  return line(
    el,
    [
      ['▄', P.blue], [' build  ', P.over0],
      ['▀', P.mauve], [' review  ', P.over0],
      ['░', P.surf2], [' ahead  ', P.over0],
      ['░', P.peach], [' critical  ', P.over0],
      ['▁▄█', P.green], [' tier per try', P.over0],
    ],
    width,
  )
}

export function flightPlan(el: El, s: Sprint, f: Forecast, o: { width: number; terminal: boolean; replay: boolean; span?: [number, number]; steady?: Sprint }) {
  const { Box } = el
  const width = o.width
  const cols = flightColumns(width)
  const span = o.span ?? flightSpan(s, f)
  const passed = s.lanes.filter(l => l.status === 'passed').length
  const ended = s.endedAt
  const agoText = ended !== null ? D.ago(s.at - ended) : ''
  const base = o.replay
    ? `${D.clock(s.at - s.startedAt)} of ${D.clock(span[1] - s.startedAt)}`
    : ended !== null
      ? `${passed} of ${s.lanes.length} passed · ${agoText === 'now' ? 'finished just now' : `finished ${agoText} ago`} · took ${D.clock(ended - s.startedAt)}`
      : s.stage === 'done'
        ? `${passed} of ${s.lanes.length} passed`
        : f.eta !== null
          ? `${passed} of ${s.lanes.length} passed · about ${Math.max(1, Math.round((f.eta - s.at) / 60_000))} min left`
          : 'planning'
  const info = s.round > 0 ? `fix round ${s.round} · ${base}` : base
  const children: unknown[] = [rule(el, width, o.replay ? 'REPLAY' : 'FLIGHT PLAN', info)]
  const steady = o.steady
  const rowsWanted = Math.max(s.lanes.length, steady?.lanes.length ?? 0)
  if (s.deciders.length) children.push(deciderLine(el, s, width))
  else if (steady?.deciders.length) children.push(line(el, [[' ', P.over0]], width))
  if (s.lanes.length === 0) {
    children.push(line(el, [['tickets appear here once the plan is ready', P.over0]], width))
    if (rowsWanted > 0) {
      for (let i = 1; i < rowsWanted; i++) children.push(line(el, [[' ', P.over0]], width))
      if (cols.strip > 0) children.push(line(el, [[' ', P.over0]], width))
    }
  } else {
    const left = s.lanes.map(lane => {
      const [glyph, color] = glyphFor(lane)
      const critical = f.projections[lane.id]?.critical === true || f.criticalPath.includes(lane.id)
      return line(
        el,
        [
          [glyph, color], [' ', P.over0],
          [fit(lane.id.slice(0, cols.idW - 1), cols.idW - 1), critical ? P.peach : P.sub0, critical], [' ', P.over0],
          [fit(lane.title, cols.titleW), lane.status === 'waiting' || lane.status === 'skipped' ? P.over1 : P.text], [' ', P.over0],
          ...pipsFor(lane, cols.pipsW),
        ],
        2 + cols.idW + cols.titleW + 1 + cols.pipsW,
      )
    })
    const right = s.lanes.map(lane => {
      const [text, color] = rightOf(lane, s, f, cols.rightW)
      return line(el, [[' ', P.over0], [text, color]], cols.rightW + 1)
    })
    for (let i = s.lanes.length; i < rowsWanted; i++) {
      left.push(line(el, [[' ', P.over0]], 2 + cols.idW + cols.titleW + 1 + cols.pipsW))
      right.push(line(el, [[' ', P.over0]], cols.rightW + 1))
    }
    const parts: unknown[] = [<Box key="flight-left" flexDirection="column">{left}</Box>]
    if (cols.strip > 0) {
      let canvas = flightCanvas(s, f, span[0], span[1], cols.strip)
      if (canvas.rows < rowsWanted) {
        const tall = new Canvas(cols.strip, rowsWanted)
        tall.words.set(canvas.words.subarray(0, cols.strip * canvas.rows * 3))
        canvas = tall
      }
      parts.push(paint(el, canvas, 'flight-strips', o.terminal))
    }
    parts.push(<Box key="flight-right" flexDirection="column">{right}</Box>)
    children.push(<Box key="flight-rows" flexDirection="row">{parts}</Box>)
    if (cols.strip > 0) children.push(axisLine(el, s, span, width, cols, o.replay))
  }
  children.push(closerLine(el, s, width))
  if (width >= 70) children.push(legendLine(el, width))
  return (
    <Box key={`flight-${s.runId}`} flexDirection="column">
      {children}
    </Box>
  )
}
