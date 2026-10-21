import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import Scrubber, { timeOf, xOf } from '../hooks/scrubber.js'

type On = Parameters<TestBody>[1]

const pane = <S extends 'terminal' | 'desktop' | 'mobile'>(surface: S) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns: 84,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 70 },
      view: {},
    },
  }) as const

const spawnInput = (description: string, workflow?: { runId: string; agentIndex: number }) => ({
  tool_use_id: 'toolu_wf',
  prompt: 'do it',
  description,
  subagentType: 'workflow-subagent',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...(workflow ? { workflow } : {}),
})

const RUN = 'wf_s'
const JOURNAL = `/t/s/subagents/workflows/${RUN}/journal.jsonl`
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const journal =
  line({ type: 'launched' }) +
  line({ type: 'started', agentId: 'p1', label: 'plan (top·high)', phase: 'plan', key: 'p1' }) +
  line({
    type: 'result',
    agentId: 'p1',
    key: 'p1',
    result: {
      tickets: [
        { id: 'T1', title: 'First', kind: 'routine', dependsOn: [], estimateMin: 4 },
        { id: 'T2', title: 'Second', kind: 'hard', dependsOn: ['T1'], estimateMin: 9 },
      ],
    },
  })

async function setup($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: journal }
  })
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `p${++n}` }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  await $.agent.spawn(spawnInput('plan (top·high)', { runId: RUN, agentIndex: 1 }))
  await clock.advance(60_000)
  await $.turn.complete({ agentId: 'p1', reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await clock.advance(3 * 60_000)
  return clock
}

test('the scrubber Client is drawn on the terminal and dragging it enters replay', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ key: 'scrubber' })).toBeDefined()
  expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
  expect(await ui.find({ in: 'scrubber', text: /●/ })).toBeDefined()
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  expect(await ui.find({ in: 'scrubber', text: /◆/ })).toBeDefined()
  await ui.pointer({ type: 'move', x: 10, y: 0, button: 'left', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  await ui.key({ key: 'l', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
  await ui.unmount()
})

test('a null post from the scrubber returns the pane to live', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  await ui.post({ runId: RUN, at: null }, { in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
  await ui.unmount()
})

test('arrow keys step the cursor back and forward to the end of a finished run, and l goes live', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.key({ key: 'left', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  await ui.key({ key: 'right', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  await ui.key({ key: 'l', in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
  await ui.unmount()
})

test('on a finished run the arrow keys stay inside the run and return to live', async () => {
  const MIN = 60_000
  const posts: { at: number | null }[] = []
  let onKey: ((e: { key: string }) => void) | undefined
  const surface = {
    elements: { Box: (p: unknown) => p, Text: (p: unknown) => p },
    state: undefined as { lastX: number } | undefined,
    setState(next: { lastX: number }) {
      this.state = next
    },
    columns: 84,
    rows: 1,
    every: () => () => undefined,
    onPointer: () => () => undefined,
    onKey: (fn: (e: { key: string }) => void) => {
      onKey = fn
      return () => undefined
    },
    post: (d: { at: number | null }) => {
      posts.push(d)
    },
  }
  let p = { runId: 'wf_done', cols: 84, from: 0, to: 30 * MIN, now: 180 * MIN, at: null as number | null }
  const press = (key: string) => {
    ;(Scrubber as never as (p: unknown, s: unknown) => unknown)(p, surface)
    onKey?.({ key })
    p = { ...p, at: posts[posts.length - 1]!.at }
  }
  press('left')
  expect(p.at).not.toBeNull()
  expect(p.at as number).toBeGreaterThanOrEqual(0)
  expect(p.at as number).toBeLessThanOrEqual(p.to)
  press('left')
  let presses = 0
  while (p.at !== p.to && presses < 200) {
    press('right')
    presses++
    expect(p.at as number).toBeLessThanOrEqual(p.to)
  }
  expect(p.at).toBe(p.to)
  expect(posts.every(x => x.at !== null && x.at <= p.to)).toBe(true)
})

test('a malformed post leaves the cursor alone', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.post({ runId: 5, at: 'soon' }, { in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
  await ui.unmount()
})

test('on mobile no Client is drawn and the replay buttons remain', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('mobile'))
  expect(await ui.find({ key: 'scrubber' })).toBeUndefined()
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(await ui.find({ key: 'next' })).toBeDefined()
  await ui.unmount()
})

test('scrubber columns match the flight-plan strip floor rule', async () => {
  const from = 0
  const to = 600000
  for (const cols of [31, 43, 57]) {
    const p = { runId: 'r', from, to, now: to, at: null, cols } as never
    for (let i = 0; i <= 1000; i++) {
      const t = (i / 1000) * to
      expect(xOf(p, t)).toBe(Math.min(cols - 1, Math.floor((t / to) * cols)))
    }
    for (let x = 0; x < cols; x++) expect(xOf(p, timeOf(p, x))).toBe(x)
  }
})

test('a column turned into a time and rounded to whole milliseconds, as a click is, lands back in that column', () => {
  const from = 1_792_553_650_597
  for (const span of [60_000, 600_000, 1_800_000, 4_321_987, 10_800_000]) {
    for (const cols of [31, 43, 57, 84]) {
      const p = { runId: 'r', from, to: from + span, now: from + span, at: null, cols } as never
      for (let x = 0; x < cols; x++) expect(xOf(p, Math.round(timeOf(p, x)))).toBe(x)
    }
  }
})

const flat = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  return flat((n as { children?: unknown }).children)
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const width of [60, 84, 110]) {
    test(`on the ${surface} at ${width} columns, a click on any column left of now puts the replay cursor in that column`, async ($, on) => {
      await setup($, on)
      const base = pane(surface)
      const ui = await $.ui.mount({ ...base, props: { ...base.props, bodyColumns: width } })
      const now = [...flat(await ui.drawn({ in: 'scrubber' }))].indexOf('●')
      expect(now).toBeGreaterThan(0)
      const misses: string[] = []
      for (let x = 0; x < now; x++) {
        await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'scrubber' })
        const landed = [...flat(await ui.drawn({ in: 'scrubber' }))].indexOf('◆')
        if (landed !== x) misses.push(`${x} → ${landed}`)
      }
      expect(misses).toEqual([])
      await ui.unmount()
    })
  }
}

type Handlers = { pointer?: (e: unknown) => void; key?: (e: unknown) => void }
function fakeClient(p: { runId: string; cols: number; from: number; to: number; now: number; at: number | null }) {
  const MIN = 60_000
  void MIN
  const posts: { runId: string; at: number | null }[] = []
  const h: Handlers = {}
  const texts: Record<string, unknown>[] = []
  const surface = {
    elements: { Box: (x: unknown) => x, Text: (x: Record<string, unknown>) => (texts.push(x), x) },
    state: undefined as { lastX: number } | undefined,
    setState(n: { lastX: number }) {
      this.state = n
    },
    columns: p.cols,
    rows: 1,
    every: () => () => undefined,
    onPointer: (fn: (e: unknown) => void) => ((h.pointer = fn), () => undefined),
    onKey: (fn: (e: unknown) => void) => ((h.key = fn), () => undefined),
    post: (d: { runId: string; at: number | null }) => posts.push(d),
  }
  ;(Scrubber as never as (p: unknown, s: unknown) => unknown)(p, surface)
  return { posts, h, texts }
}

const ended = { runId: 'wf_e', cols: 84, from: 0, to: 30 * 60_000, now: 40 * 60_000, at: null as number | null }

test('a finished run: a pointer down on the last column posts the run end, not live', () => {
  const c = fakeClient(ended)
  c.h.pointer!({ type: 'down', x: 83, y: 0, button: 'left' })
  expect(c.posts).toEqual([{ runId: 'wf_e', at: ended.to }])
})

test('a finished run: dragging to the end posts the run end', () => {
  const c = fakeClient(ended)
  c.h.pointer!({ type: 'down', x: 10, y: 0, button: 'left' })
  c.h.pointer!({ type: 'move', x: 120, y: 0, button: 'left' })
  expect(c.posts[0]!.at).toBe(timeOf(ended, 10))
  expect(c.posts[1]).toEqual({ runId: 'wf_e', at: ended.to })
})

test('a finished run: the right arrow from the end posts the run end', () => {
  const c = fakeClient({ ...ended, at: ended.to })
  c.h.key!({ key: 'right' })
  expect(c.posts).toEqual([{ runId: 'wf_e', at: ended.to }])
})

test('the l key, Return and End still post null on a finished run', () => {
  for (const key of ['l', 'return', 'end']) {
    const c = fakeClient({ ...ended, at: 5 * 60_000 })
    c.h.key!({ key })
    expect(c.posts).toEqual([{ runId: 'wf_e', at: null }])
  }
})

test('a live run: the last column still posts null', () => {
  const live = { ...ended, now: 20 * 60_000, to: 20 * 60_000 }
  const c = fakeClient({ ...live, now: 20 * 60_000 })
  c.h.pointer!({ type: 'down', x: 83, y: 0, button: 'left' })
  expect(c.posts).toEqual([{ runId: 'wf_e', at: null }])
})

test('every Text the scrubber Client builds carries mono', () => {
  const c = fakeClient(ended)
  expect(c.texts.length).toBeGreaterThan(0)
  expect(c.texts.every(t => t.mono === true)).toBe(true)
})

test('a left step from the strip left edge posts a time before from, so planning stays reachable', () => {
  const MIN = 60_000
  const p = { runId: 'wf_e', cols: 84, from: 40 * MIN, to: 90 * MIN, now: 100 * MIN, at: 40 * MIN }
  const c = fakeClient(p)
  c.h.key!({ key: 'left' })
  expect(c.posts).toHaveLength(1)
  expect(c.posts[0]!.at as number).toBeLessThan(p.from)
})

test('a scrub message with an at before the run start is stored as the run start', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.post({ runId: RUN, at: -5_000_000 }, { in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  await ui.key({ key: 'right', in: 'scrubber' })
  expect(await ui.find({ text: /(^|\s)0:10 of \d/ })).toBeDefined()
  await ui.unmount()
})
