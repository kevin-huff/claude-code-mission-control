import { base64 } from './deck'

export const DEFAULT = 0x01000000

// The surface's element table, from $.ui.resolve(e).
export type El = Record<string, any>

export function hex(color: string): number {
  return parseInt(color.replace('#', ''), 16)
}

export function toHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function mix(a: number, b: number, t: number): number {
  const channel = (shift: number) => {
    const x = (a >> shift) & 255
    const y = (b >> shift) & 255
    return Math.round(x + (y - x) * t) & 255
  }
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export function along(stops: readonly number[], t: number): number {
  if (stops.length < 2) return stops[0] ?? DEFAULT
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  return mix(stops[i] ?? DEFAULT, stops[i + 1] ?? DEFAULT, x - i)
}

function hash(n: number): number {
  let x = n | 0
  x = (x ^ 61) ^ (x >>> 16)
  x = x + (x << 3)
  x = x ^ (x >>> 4)
  x = Math.imul(x, 0x27d4eb2d)
  return (x ^ (x >>> 15)) >>> 0
}

// A grid of cells, each a width-1 glyph with a foreground and a background.
export class Canvas {
  readonly words: Uint32Array

  constructor(
    readonly cols: number,
    readonly rows: number,
    bg = DEFAULT,
  ) {
    this.words = new Uint32Array(Math.max(1, cols * rows) * 3)
    for (let i = 0; i < cols * rows; i++) {
      this.words[i * 3] = 0x20
      this.words[i * 3 + 1] = DEFAULT
      this.words[i * 3 + 2] = bg
    }
  }

  put(x: number, y: number, ch: string | number, fg: number, bg?: number): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = (y * this.cols + x) * 3
    this.words[i] = typeof ch === 'number' ? ch : ch.codePointAt(0) ?? 0x20
    this.words[i + 1] = fg
    if (bg !== undefined) this.words[i + 2] = bg
  }

  text(x: number, y: number, s: string, fg: number | ((i: number) => number), bg?: number): void {
    let i = 0
    for (const ch of s) {
      this.put(x + i, y, ch, typeof fg === 'number' ? fg : fg(i), bg)
      i += 1
    }
  }

  encode(): string {
    return base64(new Uint8Array(this.words.buffer))
  }
}

// The terminal draws a canvas as one Raster; other surfaces get the same cells as colored text.
export function paint(el: El, canvas: Canvas, key: string, terminal: boolean) {
  const { Raster, Box, Text } = el
  if (terminal && Raster) return <Raster key={key} columns={canvas.cols} rows={canvas.rows} cells={canvas.encode()} />
  const lines = []
  for (let y = 0; y < canvas.rows; y++) {
    const runs: { fg: number; bg: number; s: string }[] = []
    for (let x = 0; x < canvas.cols; x++) {
      const i = (y * canvas.cols + x) * 3
      const ch = String.fromCodePoint(canvas.words[i] ?? 0x20)
      const fg = canvas.words[i + 1] ?? DEFAULT
      const bg = canvas.words[i + 2] ?? DEFAULT
      const last = runs[runs.length - 1]
      if (last && last.fg === fg && last.bg === bg) last.s += ch
      else runs.push({ fg, bg, s: ch })
    }
    lines.push(
      <Text mono>
        {runs.map(run => {
          const props: Record<string, string | boolean> = { mono: true }
          if (run.fg !== DEFAULT) props['color'] = toHex(run.fg)
          if (run.bg !== DEFAULT) props['backgroundColor'] = toHex(run.bg)
          return <Text {...props}>{run.s}</Text>
        })}
      </Text>,
    )
  }
  return (
    <Box key={key} flexDirection="column">
      {lines}
    </Box>
  )
}

const STARS = [0x2801, 0x2802, 0x2804, 0x2808, 0x2810, 0x2820, 0xb7]

// The banner: a dark band of stars that twinkle with the clock, the title in a gradient.
export function banner(cols: number, at: number, title: string, left: string, right: string, rightColor: number): Canvas {
  const bg = hex('#11111b')
  const c = new Canvas(cols, 3, bg)
  const beat = Math.floor(at / 1000)
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < cols; x++) {
      const h = hash(x * 73856093 + y * 19349663)
      if (h % 13 !== 0) continue
      const bright = (h + beat) % 9 === 0
      const glyph = bright ? 0x2b : STARS[h % STARS.length] ?? 0xb7
      c.put(x, y, glyph, bright ? hex('#f5e0dc') : mix(hex('#45475a'), hex('#9399b2'), ((h >> 5) % 10) / 10), bg)
    }
  }
  const spaced = cols >= 60 ? [...title].join(' ') : title
  const stops = [hex('#cba6f7'), hex('#89b4fa'), hex('#94e2d5')]
  for (let x = 1; x < Math.min(cols, spaced.length + 4); x++) c.put(x, 1, 0x20, DEFAULT, bg)
  c.text(2, 1, spaced, i => along(stops, i / Math.max(1, spaced.length - 1)), bg)
  for (let x = 1; x < Math.min(cols, left.length + 4); x++) c.put(x, 2, 0x20, DEFAULT, bg)
  c.text(2, 2, left, hex('#7f849c'), bg)
  const rx = Math.max(spaced.length + 4, cols - right.length - 2)
  for (let x = rx - 1; x < Math.min(cols, rx + right.length + 1); x++) c.put(x, 1, 0x20, DEFAULT, bg)
  c.text(rx, 1, right, rightColor, bg)
  return c
}

// A 3x5 pixel font for the tiles' numbers, drawn with half blocks: three rows of cells.
const FONT: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  k: ['#..', '#.#', '##.', '#.#', '#.#'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '.': ['.', '.', '.', '.', '#'],
  '-': ['...', '...', '###', '...', '...'],
}

export function bigWidth(text: string): number {
  let cols = 0
  for (const ch of text) cols += (FONT[ch] ?? FONT['-'] ?? ['...'])[0]?.length ?? 3
  return Math.max(1, cols + Math.max(0, [...text].length - 1))
}

export function bigText(text: string, fg: number, width = bigWidth(text)): Canvas {
  const c = new Canvas(width, 3)
  let x0 = Math.max(0, Math.floor((width - bigWidth(text)) / 2))
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT['-'] ?? []
    const w = glyph[0]?.length ?? 3
    for (let gx = 0; gx < w; gx++) {
      for (let cy = 0; cy < 3; cy++) {
        const top = glyph[cy * 2]?.charAt(gx) === '#'
        const bottom = glyph[cy * 2 + 1]?.charAt(gx) === '#'
        if (top || bottom) c.put(x0 + gx, cy, top && bottom ? 0x2588 : top ? 0x2580 : 0x2584, fg)
      }
    }
    x0 += w + 1
  }
  return c
}

const EIGHTHS = [0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589]

// A smooth bar: whole cells, then a left-eighths block for the part, on a dim track.
export function meter(cols: number, fraction: number, fg: number, track = hex('#313244')): Canvas {
  const c = new Canvas(cols, 1)
  const filled = Math.max(0, Math.min(cols, fraction * cols))
  for (let x = 0; x < cols; x++) {
    const part = filled - x
    if (part >= 1) c.put(x, 0, 0x2588, fg)
    else if (part > 0.06) c.put(x, 0, EIGHTHS[Math.min(6, Math.floor(part * 7))] ?? 0x258f, fg, track)
    else c.put(x, 0, 0x2588, track)
  }
  return c
}

// Shares of one bar, each cell to whichever part it falls in (largest remainders first).
export function stacked(cols: number, parts: readonly { value: number; color: number }[], track = hex('#313244')): Canvas {
  const c = new Canvas(cols, 1)
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0)
  if (total <= 0) {
    for (let x = 0; x < cols; x++) c.put(x, 0, 0x2588, track)
    return c
  }
  const exact = parts.map(p => (Math.max(0, p.value) / total) * cols)
  const whole = exact.map(Math.floor)
  let left = cols - whole.reduce((n, w) => n + w, 0)
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    whole[i] = (whole[i] ?? 0) + 1
    left -= 1
  }
  let x = 0
  parts.forEach((p, i) => {
    for (let k = 0; k < (whole[i] ?? 0); k++) c.put(x++, 0, 0x2588, p.color)
  })
  return c
}

const LEVELS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

// A sparkline `rows` tall, newest value at the right edge.
export function spark(cols: number, rows: number, values: readonly number[], color: (v: number, max: number) => number): Canvas {
  const c = new Canvas(cols, rows)
  const series = values.slice(-cols)
  const offset = cols - series.length
  const max = Math.max(1, ...series)
  series.forEach((v, i) => {
    let eighths = Math.round((v / max) * rows * 8)
    if (v > 0 && eighths === 0) eighths = 1
    for (let r = 0; r < rows; r++) {
      const level = Math.max(0, Math.min(8, eighths - r * 8))
      if (level > 0) c.put(offset + i, rows - 1 - r, LEVELS[level] ?? 0x2588, color(v, max))
    }
  })
  return c
}
