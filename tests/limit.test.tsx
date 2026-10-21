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

const JOURNAL = '/t/s/subagents/workflows/wf_l/journal.jsonl'
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
        { id: 'T1', title: 'First job', kind: 'routine', dependsOn: [], estimateMin: 4 },
        { id: 'T2', title: 'Second job', kind: 'hard', dependsOn: ['T1'], estimateMin: 9 },
        { id: 'T3', title: 'Third job', kind: 'routine', dependsOn: [], estimateMin: 5 },
      ],
    },
  })

async function setup($: Engine, on: On, args: unknown) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's' }))
  on('fs.write', () => {
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: journal }
  })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'p1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Workflow',
    tool_use_id: 'toolu_wf',
    script: "export const meta = { name: 'sprint' }",
    args,
    transcript_path: '/t/s.jsonl',
  } as never)
  await $.agent.spawn({
    tool_use_id: 'toolu_wf',
    prompt: 'do it',
    description: 'plan (top·max)',
    subagentType: 'workflow-subagent',
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    workflow: { runId: 'wf_l', agentIndex: 1 },
  })
  await clock.advance(4_000)
  await $.turn.complete({ agentId: 'p1', reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
  await clock.advance(4_000)
}

test('a ticket limit of 2 draws two lanes and leaves the third ticket out', async ($, on) => {
  await setup($, on, { maxTickets: 2 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^. T1 / }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^. T2 / }), surface).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /T3|Third job/ }), surface).toBeUndefined()
    await ui.unmount()
  }
})

test('arguments that arrive as a string are the goal, as the workflow reads them, so the default limit holds', async ($, on) => {
  await setup($, on, '{"maxTickets": 2}')
  const unlimited = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await unlimited.find({ type: 'Text', text: /^. T2 / })).toBeDefined()
  expect(await unlimited.find({ type: 'Text', text: /T3|Third job/ })).toBeDefined()
  await unlimited.unmount()
})

test('no limit given means the default of 16 and all three tickets draw', async ($, on) => {
  await setup($, on, undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^. T3 / })).toBeDefined()
  await ui.unmount()
})
