import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { Deck, ScrubProps } from '../types'
import { flightColumns, flightSpan } from '../hooks/flight'
import { pickHero, sprintViews } from '../hooks/hero'

type On = Parameters<TestBody>[1]

const pane = <S extends 'terminal' | 'desktop' | 'mobile'>(surface: S, bodyColumns = 84, bodyRows = 70, view: { agentId?: string } = {}) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: {
      title: 'Mission Control',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view,
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

const RUN = 'wf_v'
const JOURNAL = `/t/s/subagents/workflows/${RUN}/journal.jsonl`
const STATUS = '/tmp/.claude-statusline-last.json'
const status = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 30, resets_at: 100_000 } } })
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

// The sprint is live for 'live' (its planner never answers) or has ended a minute before the pane is drawn.
async function setup($: Engine, on: On, state: 'live' | 'finished') {
  const clock = mock.clock(on, { now: 1_000_000 })
  const mirrored: string[] = []
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path === STATUS) return { value: status }
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: journal }
  })
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    return e.argv[0] === 'id' ? out('1000\n') : e.argv[0] === 'stat' ? out('1000 700\n') : out('')
  })
  on('fs.write', (_, e) => {
    mirrored.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'p1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  await $.agent.spawn(spawnInput('plan (top·high)', { runId: RUN, agentIndex: 1 }))
  await clock.advance(120_000)
  if (state === 'finished') {
    await $.turn.complete({ agentId: 'p1', reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
    await clock.advance(60_000)
  }
  return { clock, mirrored }
}

const limitLine = { type: 'Text', text: /5-hour limit/ } as const

test('a live sprint that is not being replayed shows the 5-hour limit line', async ($, on) => {
  await setup($, on, 'live')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find(limitLine)).toBeDefined()
    await ui.unmount()
  }
})

test('a sprint that finished a minute ago shows no 5-hour limit line', async ($, on) => {
  await setup($, on, 'finished')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'scrubber' })).toBeDefined()
    expect(await ui.find(limitLine)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /window reset/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a replaying live sprint keeps the same 5-hour limit line, since it describes the present', async ($, on) => {
  await setup($, on, 'live')
  const ui = await $.ui.mount(pane('terminal'))
  const before = await ui.find(limitLine)
  expect(before).toBeDefined()
  await ui.post({ runId: RUN, at: 1_000_000 + 90_000 }, { in: 'scrubber' })
  expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
  expect((await ui.find(limitLine))?.text).toBe(before?.text)
  await ui.unmount()
})

for (const [width, strip, indent] of [
  [60, 31, 18],
  [84, 43, 30],
  [110, 52, 41],
] as const) {
  test(`at ${width} columns the scrubber covers the flight-plan strip: ${strip} columns starting at column ${indent}`, async ($, on) => {
    const { mirrored } = await setup($, on, 'live')
    const deck = JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck
    const hero = pickHero(sprintViews(deck, null))
    if (!hero) throw new Error('no sprint')
    const [from, to] = flightSpan(hero.s, hero.f)
    expect(flightColumns(width).strip).toBe(strip)
    const ui = await $.ui.mount(pane('terminal', width))
    const scrubber = await ui.find({ key: 'scrubber' })
    const props = scrubber?.props['props'] as ScrubProps
    expect(props.cols).toBe(strip)
    expect(props.from).toBe(from)
    expect(props.to).toBe(to)
    const slot = await ui.find({ key: 'scrub-slot' })
    expect(slot?.props['paddingLeft']).toBe(indent)
    await ui.unmount()
  })
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const kids = (n: unknown): Node[] => ((n as Node).children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)
const flat = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  return flat((n as Node).children)
}
const topKeys = async (ui: { drawn: () => Promise<unknown> }) => kids(await ui.drawn()).map(c => String(c.props?.['key'] ?? ''))

const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const WIDTHS = [48, 60, 84, 110, 140] as const

// The widest a button can draw: its label, a hotkey chip and padding, counted generously.
const BUTTON_PAD = 6

for (const surface of SURFACES) {
  test(`on ${surface} the buttons wrap within the width and sit before the flight plan, with a cursor and a viewed agent`, async ($, on) => {
    await setup($, on, 'live')
    for (const width of WIDTHS) {
      const where = `${surface} at ${width}`
      const ui = await $.ui.mount(pane(surface, width, 70, { agentId: 'p1' }))
      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'live' }), `${where}: a cursor is set`).toBeDefined()
      const row = await ui.find({ key: 'buttons' })
      expect(row, where).toBeDefined()
      expect(row?.props['flexWrap'], where).toBe('wrap')
      const buttons = (await ui.findAll({ type: 'Button' })).filter(b => ['main', 'done', 'clear', 'raise', 'back', 'next', 'live'].includes(b.key ?? ''))
      expect(buttons.length, where).toBe(7)
      const widths = buttons.map(b => [...b.text].length + BUTTON_PAD)
      expect(widths.reduce((n, w) => n + w + 1, -1), `${where}: one line would be too wide, so wrapping matters`).toBeGreaterThan(width - 1 > 100 ? 0 : width)
      const lines: number[] = [0]
      for (const w of widths) {
        const last = lines.length - 1
        const used = lines[last] ?? 0
        if (used === 0) lines[last] = w
        else if (used + 1 + w <= width) lines[last] = used + 1 + w
        else lines.push(w)
      }
      for (const w of lines) expect(w, where).toBeLessThanOrEqual(width)
      const keys = await topKeys(ui)
      const at = keys.indexOf('buttons')
      const plan = keys.indexOf(`flight-${RUN}`)
      expect(at, where).toBeGreaterThanOrEqual(0)
      expect(plan, where).toBeGreaterThan(at)
      expect(at, `${where}: right after the banner`).toBe(keys.indexOf('banner') + 1)
      await ui.unmount()
    }
  })
}

for (const surface of SURFACES) {
  test(`on ${surface} a pane under 30 rows drops the banner and tiles, and one of 70 rows draws them`, async ($, on) => {
    await setup($, on, 'live')
    for (const width of [48, 84] as const) {
      const where = `${surface} at ${width}`
      const short = await $.ui.mount(pane(surface, width, 24))
      const shortKeys = await topKeys(short)
      expect(shortKeys, where).not.toContain('banner')
      expect(shortKeys, where).not.toContain('tiles')
      expect(shortKeys[0], `${where}: buttons come first`).toBe('buttons')
      await short.unmount()
      const tall = await $.ui.mount(pane(surface, width, 70))
      const tallKeys = await topKeys(tall)
      expect(tallKeys, where).toContain('banner')
      expect(tallKeys, where).toContain('tiles')
      await tall.unmount()
    }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on ${surface} the scrubber of a sprint that ended 10 minutes ago sits under its own plan, with the strip's indent and width`, async ($, on) => {
    const { clock, mirrored } = await setup($, on, 'finished')
    await clock.advance(9 * 60_000)
    for (const width of [60, 84, 110] as const) {
      const where = `${surface} at ${width}`
      const ui = await $.ui.mount(pane(surface, width))
      const deck = JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck
      const view = sprintViews(deck, null)[0]
      if (!view) throw new Error('no sprint')
      expect(pickHero(sprintViews(deck, null)), 'ended long enough ago that no sprint leads').toBeNull()
      const cols = flightColumns(width)
      const keys = await topKeys(ui)
      const plan = keys.indexOf(`flight-${RUN}`)
      expect(plan, where).toBeGreaterThanOrEqual(0)
      expect(keys[plan + 1], where).toBe('scrub-slot')
      expect(keys.filter(k => k === 'scrub-slot').length, where).toBe(1)
      expect((await ui.findAll({ key: 'scrubber' })).length, where).toBe(1)
      const slot = await ui.find({ key: 'scrub-slot' })
      expect(slot?.props['paddingLeft'], where).toBe(2 + cols.idW + cols.titleW + 1 + cols.pipsW)
      const props = (await ui.find({ key: 'scrubber' }))?.props['props'] as ScrubProps
      expect(props.cols, where).toBe(cols.strip)
      const [from, to] = flightSpan(view.s, view.f)
      expect(props.from, where).toBe(from)
      expect(props.to, where).toBe(to)
      await ui.unmount()
    }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`on ${surface} a click on scrubber column 40 of a finished sprint keeps the cursor at column 40 after the re-render`, async ($, on) => {
    const { clock } = await setup($, on, 'finished')
    await clock.advance(9 * 60_000)
    const ui = await $.ui.mount(pane(surface, 110))
    const drawnCols = async () => [...flat(await ui.drawn({ in: 'scrubber' }))]
    expect((await drawnCols()).includes('◆')).toBe(false)
    await ui.pointer({ type: 'down', x: 40, y: 0, button: 'left', in: 'scrubber' })
    const cells = await drawnCols()
    expect(cells.indexOf('◆')).toBe(40)
    const props = (await ui.find({ key: 'scrubber' }))?.props['props'] as ScrubProps
    expect(cells.length).toBe(props.cols)
    expect(await ui.find({ text: /REPLAY/ })).toBeDefined()
    await ui.unmount()
  })
}
