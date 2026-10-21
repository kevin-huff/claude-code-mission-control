import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const pane = (surface: 'terminal' | 'desktop' | 'mobile', bodyColumns: number) =>
  ({
    plugin: 'mission-control',
    component: 'Pane',
    requestId: 'mission-control',
    surface,
    props: { title: 'Mission Control', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 70 }, view: {} },
  }) as const

const spawnInput = {
  tool_use_id: 'toolu_s',
  prompt: 'do it',
  description: 'review:world',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
}

async function setup($: Engine, on: On, out: number, kind: 'thinking' | 'text') {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's' }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.step', async function* () {
    yield { kind, index: 0, text: 'x' } as never
    await clock.sleep(2_000)
    yield { kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' } }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnInput)
  const drain = async (agentId?: string) => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3, ...(agentId ? { agentId } : {}) })) void _
  }
  const stepping = Promise.all([drain(), drain('a1')])
  await clock.advance(5_000)
  await stepping
  await clock.advance(1_000)
  return clock
}



const cases = [
  ['thinking', 'four-digit', 9_000],
  ['text', 'three-digit', 900],
] as const

for (const surface of ['terminal', 'desktop'] as const) {
  for (const [kind, name, out] of cases) {
    test(`card first line fits the width on ${surface}, ${kind}, ${name} rate`, async ($, on) => {
      await setup($, on, out, kind)
      for (let width = 48; width <= 140; width++) {
        const ui = await $.ui.mount(pane(surface, width))
        const opens = (await ui.findAll({})).filter(e => e.type === 'Button' && e.key?.startsWith('open-'))
        expect(opens.length).toBeGreaterThan(0)
        for (const o of opens) expect([...o.text].length).toBeLessThanOrEqual(width)
        if (width === 140) for (const o of opens) expect(o.text).toContain('tokens/s')
        await ui.unmount()
      }
    })
  }
}
