import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: {
    title: 'Mission Control',
    isFocused: false,
    bodyColumns: 84,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 70 },
    view: {},
  },
} as const

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

const JOURNAL = '/t/s/subagents/workflows/wf_r/journal.jsonl'
const line = (o: unknown) => `${JSON.stringify(o)}\n`
const journal =
  line({ type: 'launched' }) +
  line({ type: 'started', agentId: 'p1', label: 'plan (top·max)', phase: 'plan', key: 'p1' }) +
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
  const mirrored: string[] = []
  const reads: string[] = []
  on('session.id', () => ({ value: 's' }))
  on('fs.write', (_, e) => {
    mirrored.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    reads.push(e.path)
    return { value: journal }
  })
  on('process.run', (_, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    return e.argv[0] === 'id' ? out('1000\n') : e.argv[0] === 'stat' ? out('1000 700\n') : out('')
  })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: e.description === 'old loose' ? 'o1' : e.description === 'fresh loose' ? 'f1' : e.workflow?.runId === 'wf_new' ? 'n1' : 'p1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  await $.agent.spawn(spawnInput('plan (top·max)', { runId: 'wf_r', agentIndex: 1 }))
  await clock.advance(4_000)
  return { clock, mirrored, reads }
}

test('the journal plan is absorbed once, and an unchanged live journal is not read again', async ($, on) => {
  const { clock, mirrored, reads } = await setup($, on)
  const deck = JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as { runs?: { plan: { id: string }[] | null }[] }
  expect(deck.runs?.[0]?.plan?.map(t => t.id)).toEqual(['T1', 'T2'])
  expect(reads.length).toBe(1)
  await clock.advance(9_000)
  expect(reads.length).toBe(1)
})

test('back and live buttons drive the replay banner on both surfaces', async ($, on) => {
  await setup($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ key: 'next' })).toBeDefined()
    expect((await ui.find({ key: 'live' }))?.props?.dimColor).toBe(true)
    expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
    const replaying = await $.ui.mount({ ...PANE, surface })
    expect(await replaying.find({ text: /REPLAY/ })).toBeDefined()
    expect((await replaying.find({ key: 'live' }))?.props?.dimColor).toBe(false)
    await replaying.press({ key: 'live' })
    await replaying.unmount()
    const back = await $.ui.mount({ ...PANE, surface })
    expect(await back.find({ text: /REPLAY/ })).toBeUndefined()
    expect((await back.find({ key: 'live' }))?.props?.dimColor).toBe(true)
    await back.unmount()
  }
})

const finish = (agentId: string) =>
  ({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' }) as never

test('clearing finished runs drops a replay cursor that pointed at the cleared run', async ($, on) => {
  const { clock } = await setup($, on)
  await $.turn.complete(finish('p1'))
  await clock.advance(20_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'back' })
    await ui.unmount()
    const replaying = await $.ui.mount({ ...PANE, surface })
    expect(await replaying.find({ text: /REPLAY/ })).toBeDefined()
    expect((await replaying.find({ key: 'live' }))?.props?.dimColor).toBe(false)
    await replaying.press({ key: 'clear' })
    await replaying.unmount()
    const after = await $.ui.mount({ ...PANE, surface })
    expect(await after.find({ text: /REPLAY/ })).toBeUndefined()
    expect((await after.find({ key: 'live' }))?.props?.dimColor).toBe(true)
    await after.unmount()
    if (surface === 'terminal') {
      await $.agent.spawn(spawnInput('plan (top·max)', { runId: 'wf_r', agentIndex: 1 }))
      await $.turn.complete(finish('p1'))
      await clock.advance(20_000)
    }
  }
})

test('a new sprint after the replayed run was cleared does not show a replay of 0:00', async ($, on) => {
  const { clock } = await setup($, on)
  await $.turn.complete(finish('p1'))
  await clock.advance(20_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back' })
  await ui.unmount()
  const replaying = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await replaying.find({ text: /REPLAY/ })).toBeDefined()
  await replaying.press({ key: 'clear' })
  await replaying.unmount()
  await $.agent.spawn(spawnInput('plan (top·max)', { runId: 'wf_new', agentIndex: 1 }))
  await clock.advance(4_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const after = await $.ui.mount({ ...PANE, surface })
    expect(await after.find({ text: /REPLAY 0:00/ })).toBeUndefined()
    expect(await after.find({ text: /REPLAY/ })).toBeUndefined()
    expect((await after.find({ key: 'live' }))?.props?.dimColor).toBe(true)
    await after.unmount()
  }
})

const SIZES = [84, 110]
const SURFACES = ['terminal', 'desktop'] as const
const mountAt = ($: Engine, surface: (typeof SURFACES)[number], cols: number) =>
  $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: cols } } as never)

// Posts as the scrubber Client does; the kit runs the ui.message hooks on every surface.
const post = (ui: unknown, data: { runId: string; at: number }) =>
  (ui as { post: (d: unknown, s: { in: string }) => Promise<void> }).post(data, { in: 'scrubber' })

test('replaying a planning moment of a finished run shows the replay tiles, not the live totals', async ($, on) => {
  const { clock } = await setup($, on)
  await $.turn.complete(finish('p1'))
  await clock.advance(20_000)
  for (const surface of SURFACES) {
    for (const cols of SIZES) {
      const ui = await mountAt($, surface, cols)
      await post(ui, { runId: 'wf_r', at: 1_000_000 + 500 })
      expect(await ui.find({ text: /PASSED OF/ })).toBeDefined()
      expect(await ui.find({ text: /DONE/ })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('the live tiles say TOKENS/MIN and TIME THINKING', async ($, on) => {
  await setup($, on)
  for (const surface of SURFACES) {
    for (const cols of SIZES) {
      const ui = await mountAt($, surface, cols)
      expect(await ui.find({ text: /TIME THINKING/ })).toBeDefined()
      expect(await ui.find({ text: /OUT\/MIN/ })).toBeUndefined()
      if (cols >= 96 || cols >= 80) expect(await ui.find({ text: /TOKENS\/MIN/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('the NOW section says live agents are hidden while replaying', async ($, on) => {
  await setup($, on)
  for (const surface of SURFACES) {
    for (const cols of SIZES) {
      const ui = await mountAt($, surface, cols)
      await post(ui, { runId: 'wf_r', at: 1_000_000 + 500 })
      expect(await ui.find({ text: /Live agents are hidden while replaying/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('the subagents list leaves out loose agents that ended more than 30 minutes ago', { timeoutMs: 120_000 }, async ($, on) => {
  const { clock } = await setup($, on)
  const loose = (_id: string, description: string) => $.agent.spawn(spawnInput(description))
  await loose('o1', 'old loose')
  await $.turn.complete(finish('o1'))
  await clock.advance(2 * 3_600_000)
  await loose('f1', 'fresh loose')
  await $.turn.complete(finish('f1'))
  await clock.advance(10 * 60_000)
  for (const surface of SURFACES) {
    for (const cols of SIZES) {
      const ui = await mountAt($, surface, cols)
      expect(await ui.find({ text: /SUBAGENTS.*✓ fresh loose +opus/ })).toBeDefined()
      expect(await ui.find({ text: /SUBAGENTS.*✓ old loose +opus/ })).toBeUndefined()
      await ui.unmount()
    }
  }
})
