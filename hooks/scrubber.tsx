import type { ClientModule, ClientSurface } from 'claude-code'
import type { ScrubProps } from '../types'

type ScrubState = { lastX: number }

const PAST = '#6c7086'
const FUTURE = '#45475a'
const CURSOR = '#f9e2af'
const LIVE = '#a6e3a1'

function colsOf(p: ScrubProps): number {
  return Math.max(1, Math.floor(p.cols))
}

export function xOf(p: ScrubProps, t: number): number {
  const cols = colsOf(p)
  const span = p.to - p.from
  const x = span > 0 ? Math.floor(((t - p.from) / span) * cols) : cols - 1
  return Math.min(cols - 1, Math.max(0, x))
}

// The middle of column x, so rounding the time to whole milliseconds never moves it into a neighbour.
export function timeOf(p: ScrubProps, x: number): number {
  const cols = colsOf(p)
  return p.from + ((x + 0.5) * (p.to - p.from)) / cols
}

function send(surface: ClientSurface<ScrubState>, p: ScrubProps, at: number | null) {
  surface.post({ runId: p.runId, at })
}

function finished(p: ScrubProps): boolean {
  return p.now > p.to
}

function pointTo(surface: ClientSurface<ScrubState>, p: ScrubProps, rawX: number) {
  const x = Math.min(colsOf(p) - 1, Math.max(0, Math.round(rawX)))
  if (x === surface.state?.lastX && x === xOf(p, p.at ?? p.now)) return
  surface.setState({ lastX: x })
  if (finished(p)) send(surface, p, x >= colsOf(p) - 1 ? p.to : timeOf(p, x))
  else send(surface, p, x >= xOf(p, p.now) ? null : timeOf(p, x))
}

function step(surface: ClientSurface<ScrubState>, p: ScrubProps, dir: -1 | 1) {
  const by = Math.max(10_000, (p.to - p.from) / 40)
  const limit = Math.min(p.to, p.now)
  const at = Math.min(limit, (p.at ?? limit) + dir * by)
  surface.setState({ lastX: -1 })
  send(surface, p, dir === 1 && at >= limit && !finished(p) ? null : at)
}

function runsOf(p: ScrubProps): { text: string; color: string }[] {
  const cols = colsOf(p)
  const nowX = xOf(p, p.now)
  const curX = p.at === null ? nowX : xOf(p, p.at)
  const runs: { text: string; color: string }[] = []
  for (let x = 0; x < cols; x++) {
    const cell =
      x === curX
        ? p.at === null
          ? { text: '●', color: LIVE }
          : { text: '◆', color: CURSOR }
        : x < nowX
          ? { text: '━', color: PAST }
          : { text: '─', color: FUTURE }
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color) last.text += cell.text
    else runs.push(cell)
  }
  return runs
}

const Scrubber: ClientModule<ScrubProps, ScrubState> = (p, surface) => {
  const { Box, Text } = surface.elements
  surface.onPointer(e => {
    if (e.type === 'down' || (e.type === 'move' && e.button === 'left')) pointTo(surface, p, e.x)
  })
  surface.onKey(e => {
    if (e.key === 'left') step(surface, p, -1)
    else if (e.key === 'right') step(surface, p, 1)
    else if (e.key === 'l' || e.key === 'return' || e.key === 'end') {
      surface.setState({ lastX: -1 })
      send(surface, p, null)
    }
  })
  return Box({
    flexDirection: 'row',
    width: colsOf(p),
    height: 1,
    children: runsOf(p).map(r => Text({ mono: true, color: r.color, children: r.text })),
  })
}

export default Scrubber
