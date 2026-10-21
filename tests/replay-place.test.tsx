import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted, TestBody } from 'claude-code/testing'
import type { Deck, ScrubProps } from '../types'
import { flightColumns } from '../hooks/flight'
import { HERO_RECENT_MS, pickHero, sprintViews, viewAt } from '../hooks/hero'

type On = Parameters<TestBody>[1]

const RUN = 'wf_place'
const JOURNAL = `/t/s/subagents/workflows/${RUN}/journal.jsonl`
const MIN = 60_000
const line = (o: unknown) => `${JSON.stringify(o)}\n`

const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const WIDTHS = [48, 60, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 110, 140] as const

const pane = <S extends (typeof SURFACES)[number]>(surface: S, bodyColumns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: { title: 'Mission Control', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }) as const

const spawnInput = (description: string) => ({
  tool_use_id: 'toolu_wf',
  prompt: 'do it',
  description,
  subagentType: 'workflow-subagent',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  workflow: { runId: RUN, agentIndex: 1 },
})

const finish = (agentId: string) => ({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' }) as never

const FIX_TICKETS = [
  { id: 'X1', title: 'Fix the first thing', kind: 'routine', dependsOn: [], estimateMin: 2 },
  { id: 'X2', title: 'Fix the second thing', kind: 'routine', dependsOn: ['X1'], estimateMin: 2 },
]

const TICKETS = [
  { id: 'T1', title: 'First ticket', kind: 'routine', dependsOn: [], estimateMin: 2 },
  { id: 'T2', title: 'Second ticket', kind: 'hard', dependsOn: ['T1'], estimateMin: 3 },
  { id: 'T3', title: 'Third ticket', kind: 'routine', dependsOn: [], estimateMin: 2 },
]

// A small sprint played through the hooks: plan, three tickets built and passed, integrate, final review.
const STATUS = '/tmp/.claude-statusline-last.json'
const USAGE = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 30, resets_at: 100_000 } } })

// With `live` set, the sprint stops once the first ticket's build has started, and the status capture holds a 5-hour usage reading.
async function playSprint($: Engine, on: On, opts: { fixRound?: boolean; live?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  let journal = line({ type: 'launched' })
  const mirrored: string[] = []
  const ids = new Map<string, string>()
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (opts.live && e.path === STATUS) return { value: USAGE }
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
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: ids.get(e.description) ?? 'x' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  const step = async (id: string, label: string, result: unknown, minutes: number) => {
    ids.set(label, id)
    await $.agent.spawn(spawnInput(label))
    journal += line({ type: 'started', agentId: id, label, phase: 'p', key: id })
    await clock.advance(minutes * MIN)
    journal += line({ type: 'result', agentId: id, key: id, result })
    await $.turn.complete(finish(id))
    await clock.advance(1_000)
  }
  await step('p1', 'plan (top·max)', { tickets: TICKETS }, 2)
  if (opts.live) {
    const label = 'T1 build 1/3 (sonnet·medium)'
    ids.set(label, 'bT1')
    await $.agent.spawn(spawnInput(label))
    journal += line({ type: 'started', agentId: 'bT1', label, phase: 'p', key: 'bT1' })
    await clock.advance(2 * MIN)
    return { clock, deck: () => JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck }
  }
  for (const t of TICKETS) {
    await step(`b${t.id}`, `${t.id} build 1/3 (sonnet·medium)`, { summary: 'built', changed: [] }, 2)
    await step(`r${t.id}`, `${t.id} review 1/3 (sonnet·high)`, { pass: true, issues: [], summary: 'passes' }, 1)
  }
  await step('i1', 'integrate (top·high)', { summary: 'fits', checks: [] }, 1)
  if (opts.fixRound) {
    await step('f1', 'final review (top·max)', { verdict: 'fix first', summary: 'two gaps remain', issues: ['first gap', 'second gap'] }, 2)
    await step('x1', 'fix plan (top·high)', { tickets: FIX_TICKETS }, 2)
    // The pane renames fix-plan tickets F1, F2, ... as the workflow does, so their builds carry those ids.
    for (const id of FIX_TICKETS.map((_, i) => `F${i + 1}`)) {
      await step(`b${id}`, `${id} build 1/3 (sonnet·medium)`, { summary: 'built', changed: [] }, 2)
      await step(`r${id}`, `${id} review 1/3 (sonnet·high)`, { pass: true, issues: [], summary: 'passes' }, 1)
    }
    await step('i2', 'integrate (top·high)', { summary: 'fits', checks: [] }, 1)
    await step('f2', 'final review (top·max)', { verdict: 'ship', summary: 'all fixed' }, 2)
  } else await step('f1', 'final review (top·max)', { verdict: 'ship', summary: 'all good' }, 2)
  return { clock, deck: () => JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck }
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const kids = (n: unknown): Node[] => ((n as Node).children ?? []).filter((c): c is Node => typeof c === 'object' && c !== null)
const flat = (n: unknown): string => {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  return flat((n as Node).children)
}

// Button widths as the terminal draws them: the label and four cells for brackets and spaces, one cell between.
const BUTTON_PAD = 4
function wrapLines(widths: number[], width: number): number {
  const lines: number[] = [0]
  for (const w of widths) {
    const last = lines.length - 1
    const used = lines[last] ?? 0
    if (used === 0) lines[last] = w
    else if (used + 1 + w <= width) lines[last] = used + 1 + w
    else lines.push(w)
  }
  return lines.length
}

function height(n: unknown, width: number): number {
  if (n === null || n === undefined || typeof n === 'boolean' || typeof n === 'string' || typeof n === 'number') return 0
  if (Array.isArray(n)) return n.reduce((sum: number, c) => sum + height(c, width), 0)
  const node = n as Node
  if (node.type === 'Raster') return Number(node.props?.['rows'] ?? 1)
  if (node.type === 'Button') return 1
  if (node.type === 'Text') return node.props?.['wrap'] === 'truncate-end' ? 1 : Math.max(1, Math.ceil([...flat(node)].length / width))
  const children = kids(node)
  if (node.props?.['key'] === 'buttons') {
    const labels = children.flatMap(c => (Array.isArray(c) ? c : [c])).filter(c => c.type === 'Button')
    return wrapLines(labels.map(b => [...String(b.props?.['label'])].length + BUTTON_PAD), width)
  }
  const each = children.map(c => height(c, width))
  return node.props?.['flexDirection'] === 'row' ? Math.max(0, ...each) : each.reduce((a, b) => a + b, 0)
}

type Layout = { plan: number; scrub: number; nowFirst: boolean; before: string[]; buttons: number; hasReplayHeading: boolean }

// Where the plan heading and the scrubber sit, counted in rows from the top, and what comes before them.
async function layoutOf(ui: { drawn: () => Promise<unknown> }, width: number): Promise<Layout> {
  const top = kids(await ui.drawn())
  const at = (pred: (c: Node) => boolean) => top.findIndex(pred)
  const plan = at(c => String(c.props?.['key'] ?? '').startsWith('flight-'))
  const scrub = at(c => c.props?.['key'] === 'scrub-slot')
  const now = at(c => c.type === 'Text' && flat(c).startsWith('── NOW'))
  const rowsBefore = (index: number) => top.slice(0, index).reduce((sum, c) => sum + height(c, width), 0)
  const buttons = top.find(c => c.props?.['key'] === 'buttons')
  return {
    plan: rowsBefore(plan),
    scrub: rowsBefore(scrub),
    nowFirst: now >= 0 && now < plan,
    before: top.slice(0, scrub).map(c => String(c.props?.['key'] ?? (c.type === 'Text' ? `text:${flat(c).slice(0, 6)}` : c.type))),
    buttons: buttons ? height(buttons, width) : 0,
    hasReplayHeading: plan >= 0 && /^── REPLAY/.test(flat(kids(top[plan])[0])),
  }
}

type Ui = Mounted<'terminal' | 'desktop', 'Pane'>

// Mounts the pane at each width, clicks into replay once, checks nothing above or beside the scrubber moved, and goes back to live.
async function checkFirstClicks($: Engine, surface: (typeof SURFACES)[number], raiseOn: boolean) {
  for (const width of WIDTHS) {
    const where = `${surface} at ${width}, auto-raise ${raiseOn ? 'on' : 'off'}`
    const ui = await $.ui.mount(pane(surface, width))
    if (!raiseOn) await ui.press({ key: 'raise' })
    const before = await layoutOf(ui, width)
    expect(before.plan, `${where}: the plan is drawn`).toBeGreaterThan(0)
    expect(before.scrub, `${where}: the scrubber sits under the plan`).toBeGreaterThan(before.plan)
    expect(before.nowFirst, `${where}: NOW comes before the plan`).toBe(true)
    expect(before.hasReplayHeading, `${where}: not replaying yet`).toBe(false)
    const strip = flightColumns(width).strip
    const scrubber = await ui.find({ key: 'scrubber' })
    const startProps = scrubber?.props['props'] as ScrubProps
    if (scrubber && strip > 0) await (ui as Ui).pointer({ type: 'down', x: Math.min(10, strip - 1), y: 0, button: 'left', in: 'scrubber' })
    else await ui.press({ key: 'back' })
    expect((await ui.find({ key: 'live' }))?.props['dimColor'], `${where}: a cursor is set, so 'live' is lit`).toBe(false)
    const after = await layoutOf(ui, width)
    expect(after.hasReplayHeading, `${where}: the plan heading says REPLAY`).toBe(true)
    expect(after.plan, `${where}: plan heading row`).toBe(before.plan)
    expect(after.scrub, `${where}: scrubber row`).toBe(before.scrub)
    expect(after.nowFirst, `${where}: NOW still above the plan`).toBe(true)
    expect(after.before, `${where}: nothing is inserted above the scrubber`).toEqual(before.before)
    expect(after.buttons, `${where}: the live button adds no line to the buttons`).toBe(before.buttons)
    expect(await ui.find({ text: /^REPLAY .* of .* · l goes back to live$/ }), `${where}: no second REPLAY line`).toBeUndefined()
    expect(await ui.find({ key: 'tiles' }), where).toBeDefined()
    const props = (await ui.find({ key: 'scrubber' }))?.props['props'] as ScrubProps | undefined
    expect(props?.cols, `${where}: strip columns`).toBe(startProps?.cols)
    expect(props?.from, `${where}: strip start`).toBe(startProps?.from)
    expect(props?.to, `${where}: strip end`).toBe(startProps?.to)
    await ui.press({ key: 'live' })
    if (!raiseOn) await ui.press({ key: 'raise' })
    await ui.unmount()
  }
}

for (const surface of SURFACES) {
  for (const raiseOn of [true, false]) {
    test(`on ${surface} with auto-raise ${raiseOn ? 'on' : 'off'} the first scrubber click on a sprint that ended 10 minutes ago moves only the cursor`, { timeoutMs: 300_000 }, async ($, on) => {
      const { clock } = await playSprint($, on)
      await clock.advance(10 * MIN)
      await checkFirstClicks($, surface, raiseOn)
    })
    test(`on ${surface} with auto-raise ${raiseOn ? 'on' : 'off'} the first click on a sprint with a fix round, clicked in its first-round part, moves only the cursor`, { timeoutMs: 300_000 }, async ($, on) => {
      const { clock, deck } = await playSprint($, on, { fixRound: true })
      await clock.advance(10 * MIN)
      expect(deck().runs[0]?.plan?.map(t => t.id), 'the sprint has two fix tickets').toEqual(['T1', 'T2', 'T3', 'F1', 'F2'])
      await checkFirstClicks($, surface, raiseOn)
    })
  }
}

const LIMIT = /5-hour limit/
const limitOf = async (ui: { drawn: () => Promise<unknown> }) => kids(await ui.drawn()).map(flat).find(t => LIMIT.test(t))

for (const surface of SURFACES) {
  test(`on ${surface} the first click into a live lead sprint keeps its 5-hour limit line and moves nothing above the scrubber`, { timeoutMs: 300_000 }, async ($, on) => {
    await playSprint($, on, { live: true })
    for (const width of [48, 60, 84, 110]) {
      const where = `${surface} at ${width}`
      const ui = await $.ui.mount(pane(surface, width))
      const text = await limitOf(ui)
      expect(text, `${where}: the limit line is drawn`).toBeDefined()
      const before = await layoutOf(ui, width)
      expect(before.plan, `${where}: the plan is drawn`).toBeGreaterThan(0)
      expect(before.scrub, `${where}: the scrubber sits under the plan`).toBeGreaterThan(before.plan)
      expect(before.hasReplayHeading, `${where}: not replaying yet`).toBe(false)
      const strip = flightColumns(width).strip
      // The strip's last column means "now", which stays live, and a click close to it counts as live, so click near the start.
      if ((await ui.find({ key: 'scrubber' })) && strip > 0) await (ui as Ui).pointer({ type: 'down', x: Math.min(10, Math.floor(strip / 8)), y: 0, button: 'left', in: 'scrubber' })
      else await ui.press({ key: 'back' })
      expect((await ui.find({ key: 'live' }))?.props['dimColor'], `${where}: a cursor is set, so 'live' is lit`).toBe(false)
      const after = await layoutOf(ui, width)
      expect(after.hasReplayHeading, `${where}: the plan heading says REPLAY`).toBe(true)
      expect(await limitOf(ui), `${where}: the limit line stays, with the same text`).toBe(text)
      expect(after.plan, `${where}: plan heading row`).toBe(before.plan)
      expect(after.scrub, `${where}: scrubber row`).toBe(before.scrub)
      expect(after.before, `${where}: nothing above the scrubber changes`).toEqual(before.before)
      expect(after.buttons, `${where}: the buttons keep their lines`).toBe(before.buttons)
      await ui.press({ key: 'live' })
      const back = await layoutOf(ui, width)
      expect(back, `${where}: going back to live restores the layout`).toEqual(before)
      expect(await limitOf(ui), `${where}: the limit line is there after going live`).toBe(text)
      await ui.unmount()
    }
  })
}

// A sprint that ended under five minutes ago still leads the pane and draws its own map and plan, so the
// fix-round case must hold there too: a click in the first round must not drop the fix tickets' rows.
for (const surface of SURFACES) {
  test(`on ${surface} the first click into a just-finished lead sprint with a fix round, in its first-round part, moves nothing above the scrubber`, { timeoutMs: 300_000 }, async ($, on) => {
    const { clock, deck } = await playSprint($, on, { fixRound: true })
    await clock.advance(2 * MIN)
    expect(deck().runs[0]?.plan?.map(t => t.id), 'the sprint has two fix tickets').toEqual(['T1', 'T2', 'T3', 'F1', 'F2'])
    for (const width of [48, 60, 84, 110, 140]) {
      const where = `${surface} at ${width}`
      const ui = await $.ui.mount(pane(surface, width))
      expect(kids(await ui.drawn()).map(flat).some(t => t.startsWith('Final review: ship')), `${where}: the sprint that ended 2 minutes ago leads the pane`).toBe(true)
      const before = await layoutOf(ui, width)
      expect(before.plan, `${where}: the plan is drawn`).toBeGreaterThan(0)
      expect(before.scrub, `${where}: the scrubber sits under the plan`).toBeGreaterThan(before.plan)
      expect(before.hasReplayHeading, `${where}: not replaying yet`).toBe(false)
      const strip = flightColumns(width).strip
      if ((await ui.find({ key: 'scrubber' })) && strip > 0) await (ui as Ui).pointer({ type: 'down', x: Math.min(10, strip - 1), y: 0, button: 'left', in: 'scrubber' })
      else await ui.press({ key: 'back' })
      const after = await layoutOf(ui, width)
      expect(after.hasReplayHeading, `${where}: the plan heading says REPLAY`).toBe(true)
      expect(after.plan, `${where}: plan heading row`).toBe(before.plan)
      expect(after.scrub, `${where}: scrubber row`).toBe(before.scrub)
      // The headline describes the replayed moment, so only its place is compared, not its words.
      const shape = (l: Layout) => l.before.map(k => (k.startsWith('text:') ? 'text' : k))
      expect(shape(after), `${where}: nothing above the scrubber is added, dropped or moved`).toEqual(shape(before))
      await ui.press({ key: 'live' })
      expect(await layoutOf(ui, width), `${where}: going back to live restores the layout`).toEqual(before)
      await ui.unmount()
    }
  })
}

test('a click does not add a headline or a sprint map to a pane with no lead sprint', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = await playSprint($, on)
  await clock.advance(10 * MIN)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface, 110))
    const keysOf = async () => kids(await ui.drawn()).map(c => String(c.props?.['key'] ?? c.type))
    const before = await keysOf()
    expect(before.some(k => k.startsWith('sky') || k === 'map'), surface).toBe(false)
    await ui.press({ key: 'back' })
    const after = await keysOf()
    expect(after.length, `${surface}: same number of sections`).toBe(before.length)
    expect(await ui.find({ text: /Waiting on|longest chain|sprint done/ }), `${surface}: no headline`).toBeUndefined()
    await ui.unmount()
  }
})

test('the replayed run keeps its strip columns and span while the cursor moves', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = await playSprint($, on)
  await clock.advance(10 * MIN)
  const ui = await $.ui.mount(pane('terminal', 110))
  const first = (await ui.find({ key: 'scrubber' }))?.props['props'] as ScrubProps
  const spans: string[] = []
  for (const x of [5, 20, 35]) {
    await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'scrubber' })
    const p = (await ui.find({ key: 'scrubber' }))?.props['props'] as ScrubProps
    spans.push(`${p.cols}:${p.from}:${p.to}`)
    expect(p.at, 'the cursor follows the click').not.toBeNull()
  }
  expect(new Set(spans).size).toBe(1)
  expect(spans[0]).toBe(`${first.cols}:${first.from}:${first.to}`)
  await ui.unmount()
})

test('the lead is judged without the cursor, and a replaying view still takes the lead slot when there is one', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock, deck } = await playSprint($, on)
  await clock.advance(10 * MIN)
  const late = deck()
  const run = late.runs[0]
  if (!run || run.endedAt === null) throw new Error('the sprint did not finish')
  const mid = { runId: run.id, at: run.startedAt + (run.endedAt - run.startedAt) / 2 }
  expect(pickHero(sprintViews(late, null))).toBeNull()
  expect(pickHero(sprintViews(late, mid)), 'replaying a finished run no one leads').toBeNull()
  const justEnded = { ...late, at: run.endedAt + HERO_RECENT_MS - 1_000 }
  expect(pickHero(sprintViews(justEnded, mid))?.replaying).toBe(true)
  const rows = late.agents.filter(a => a.runId === run.id)
  expect(viewAt(run, rows, mid, late.at)?.replaying).toBe(true)
})
