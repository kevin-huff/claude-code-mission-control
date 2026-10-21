import type { AgentRow, Code, FeedKind } from '../types'
import type { El } from './art'
import { Canvas, hex, paint } from './art'
import * as D from './deck'

// Catppuccin Mocha, to match the terminal theme.
export const P = {
  pink: '#f5c2e7',
  mauve: '#cba6f7',
  red: '#f38ba8',
  peach: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  sky: '#89dceb',
  blue: '#89b4fa',
  lavender: '#b4befe',
  text: '#cdd6f4',
  sub0: '#a6adc8',
  over1: '#7f849c',
  over0: '#6c7086',
  surf2: '#585b70',
  surf1: '#45475a',
  surf0: '#313244',
}
export const STATE: Record<Code, string> = { q: P.over1, t: P.mauve, w: P.green, x: P.teal, b: P.blue, l: P.yellow, s: P.red, i: P.surf2 }
export const GLYPH: Record<Code, string> = { q: '·', t: '✻', w: '✎', x: '❯', b: '▶', l: '◷', s: '!', i: '◦' }
export const WORD: Record<Code, string> = { q: 'waiting', t: 'thinking', w: 'writing', x: 'answering', b: 'running', l: 'long run', s: 'stuck', i: 'idle' }
export const LEGEND: Code[] = ['t', 'w', 'x', 'b', 'l', 's', 'q', 'i']
export const SHORT: Record<string, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhi', max: 'max' }
export const EFFORT_HEX: Record<string, string> = { low: P.green, medium: P.teal, high: P.blue, xhigh: P.mauve, max: P.peach }
export const FEED_LOOK: Record<FeedKind, [string, string]> = {
  start: ['▸', P.blue],
  done: ['✓', P.green],
  fail: ['✗', P.red],
  up: ['↑', P.peach],
  guard: ['⊘', P.yellow],
  warn: ['!', P.red],
  run: ['◆', P.lavender],
}

export function fit(s: string, n: number): string {
  if (n <= 0) return ''
  const chars = [...s]
  return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : s + ' '.repeat(n - chars.length)
}

export function len(s: string): number {
  return [...s].length
}

export function compact(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function tierOf(row: AgentRow): string {
  const model = D.modelShort(row.model)
  const effort = row.effort ? SHORT[row.effort] ?? row.effort.slice(0, 4) : ''
  return `${model}${model && effort ? '·' : ''}${effort}${row.bumps ? '↑' : ''}`
}

export function effortHex(row: AgentRow): string {
  return (row.effort && EFFORT_HEX[row.effort]) || P.sub0
}

export function rule(el: El, width: number, title: string, info = '') {
  const { Text } = el
  const tail = info ? ` ${info} ` : ' '
  const fill = Math.max(0, width - 3 - len(title) - len(tail))
  return (
    <Text mono wrap="truncate-end">
      <Text mono color={P.surf1}>── </Text>
      <Text mono color={P.lavender} weight="bold">{title}</Text>
      <Text mono color={P.over0}>{tail}</Text>
      <Text mono color={P.surf1}>{'─'.repeat(fill)}</Text>
    </Text>
  )
}

export function mark(row: AgentRow, now: number): [string, string] {
  if (row.outcome === 'failed') return ['✗', P.red]
  if (row.outcome === 'stopped') return ['■', P.red]
  if (row.endedAt !== null) return ['✓', P.over0]
  return D.isLive(row) ? ['●', STATE[D.displayCode(row, now)]] : ['·', P.over0]
}

// One timeline row: a lower half block per busy cell in its state's color, a thin baseline
// for idle, nothing before the agent started or after it ended.
export function strip(el: El, key: string, codes: (Code | null)[], terminal: boolean) {
  const canvas = new Canvas(Math.max(1, codes.length), 1)
  codes.forEach((code, x) => {
    if (code !== null) canvas.put(x, 0, code === 'i' ? 0x2581 : 0x2584, hex(STATE[code]))
  })
  return paint(el, canvas, key, terminal)
}

