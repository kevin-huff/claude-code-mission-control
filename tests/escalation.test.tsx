import { expect, mock, test } from 'claude-code/testing'

test('after two failed commands, the next request beneath the mod carries the raised effort', async ($, on) => {
  const clock = mock.clock(on, { now: 9_000_000 })
  const seen: unknown[] = []
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {}, isError: true, text: 'Exit code 1' }))
  on('turn.step', async function* (_, e) {
    seen.push(e.effort)
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ tool_use_id: 't', prompt: 'p', description: 'ticket', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'x', background: true, fork: false })
  const step = async (index: number) => {
    for await (const _ of $.turn.step({ turnId: 't1', index, model: 'claude-haiku-5-5', effort: 'low', messageCount: 2, agentId: 'a1' })) void _
  }
  await step(0)
  // The kit carries agentId into tool.call at run time, though its input type leaves it out.
  const call = (n: number) => $.tool.call({ tool: 'Bash', command: `false ${n}`, description: 'run tests', agentId: 'a1' } as never)
  await call(1)
  await call(2)
  await clock.advance(1_000)
  await step(1)
  expect(seen).toEqual(['low', 'medium'])
})
