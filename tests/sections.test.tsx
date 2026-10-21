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

async function setup($: Engine, on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's' }))
  on('fs.write', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.step', async function* () {
    await clock.sleep(2_000)
    yield { kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 9_000, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' } }
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
}

function textsIn(node: { children: unknown[] }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const child of node.children) {
    if (child && typeof child === 'object') {
      const c = child as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
      if (c.type === 'Text') out.push(c.props ?? {})
      out.push(...textsIn({ children: c.children ?? [] }))
    }
  }
  return out
}

const SURFACES = ['terminal', 'desktop', 'mobile'] as const
const WIDTHS = [48, 60, 84, 110, 140] as const

for (const surface of SURFACES) {
  for (const width of WIDTHS) {
    test(`cards fit ${width} columns on ${surface}, spelled out, with mono text`, async ($, on) => {
      await setup($, on)
      const ui = await $.ui.mount(pane(surface, width))
      const all = await ui.findAll({})
      const opens = all.filter(e => e.type === 'Button' && e.key?.startsWith('open-'))
      expect(opens.length).toBeGreaterThan(0)
      for (const o of opens) {
        expect([...o.text].length).toBeLessThanOrEqual(width)
        if (width < 56) expect(o.text).not.toContain('tokens/s')
        else expect(o.text).toContain('tokens/s')
        expect(o.text).not.toContain('tok/s')
      }
      const ctxs = all.filter(e => e.type === 'Box' && e.key?.startsWith('ctx-'))
      expect(ctxs.length).toBeGreaterThan(0)
      for (const c of ctxs) {
        const rasters = c.children.filter(k => (k as { type?: string }).type === 'Raster') as { props?: { columns?: number } }[]
        const drawn = [...c.text].length + rasters.reduce((n, r) => n + (r.props?.columns ?? 0), 0)
        expect(drawn).toBeLessThanOrEqual(width)
        expect(c.text).toContain('context')
        expect(c.text).not.toMatch(/\bctx\b|\bcmds\b|\berr\b/)
      }
      if (width >= 84) for (const c of ctxs) expect(c.text).toMatch(/commands.*errors.*tokens out/)
      let texts = 0
      for (const c of [...opens, ...ctxs]) {
        for (const t of textsIn(c)) {
          texts++
          expect(t['mono']).toBe(true)
        }
      }
      expect(texts).toBeGreaterThan(0)
      expect(await ui.find({ type: 'Text', text: /guards/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /quiet/ })).toBeUndefined()
      await ui.unmount()
    })
  }
}

for (const surface of SURFACES) {
  for (const width of [48, 84, 140] as const) {
    test(`throughput is labelled tokens/min on ${surface} at ${width} columns`, async ($, on) => {
      await setup($, on)
      const ui = await $.ui.mount(pane(surface, width))
      expect(await ui.find({ type: 'Text', text: /^tokens\/min/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^out\s*$/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^out\s/ })).toBeUndefined()
      await ui.unmount()
    })
  }
}
