import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import { bigWidth, meter, spark, stacked } from '../hooks/art'
import * as D from '../hooks/deck'

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

const run = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// The host answers the three questions the mirror folder takes: who am I, make the folder, whose is it.
function claudeTemp(on: Parameters<TestBody>[1], made: string[] = [], seen = '1000 700\n') {
  on('process.run', (_, e) => {
    const [cmd] = e.argv
    if (cmd === 'id') return run('1000\n')
    if (cmd === 'mkdir') {
      made.push(e.argv.join(' '))
      return run('')
    }
    if (cmd === 'stat') return run(seen)
    return run('', 127)
  })
}

const facts = (agentId: string, runId: string | null = 'wf_test', index = 1): D.SpawnFacts => ({
  agentId,
  description: `review:${agentId}`,
  subagentType: 'workflow-subagent',
  model: 'claude-opus-5-5',
  runId,
  index,
  toolUseId: 'toolu_wf',
  isTeammate: false,
})

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

test('a long command turns long, then stuck near its limit, with exactly one warning', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 0)
  D.stepStarted(store, 'a1', { effort: 'high', model: 'opus' }, 0)
  D.toolStarted(store, 'a1', { id: 'b1', tool: 'Bash', label: 'Render 12 stills', since: 1_000, limitMs: 600_000 }, 1_000)
  const row = store.agents.get('a1')
  if (!row) throw new Error('no row')
  expect(D.displayCode(row, 30_000)).toBe('b')
  expect(D.displayCode(row, 90_000)).toBe('l')
  expect(D.tick(store, 400_000)).toEqual([])
  const warned = D.tick(store, 520_000)
  expect(warned.length).toBe(1)
  expect(warned[0]).toContain('Render 12 stills')
  expect(D.tick(store, 521_000)).toEqual([])
  D.toolEnded(store, 'a1', 'b1', false, 530_000)
  expect(D.displayCode(row, 531_000)).toBe('q')
  expect(row.recent[0]?.label).toBe('Render 12 stills')
  expect(store.feed.some(item => item.kind === 'warn')).toBe(true)
})

test('a request with nothing streamed reads as hidden thinking, then as stuck after six minutes', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 0)
  D.stepStarted(store, 'a1', { effort: 'max', model: 'opus' }, 10_000)
  const row = store.agents.get('a1')
  if (!row) throw new Error('no row')
  expect(D.displayCode(row, 12_000)).toBe('q')
  expect(D.displayCode(row, 20_000)).toBe('t')
  expect(D.displayCode(row, 10_000 + 6 * 60_000 + 1)).toBe('s')
})

test('two failed commands in a row raise a subagent one level, and nothing raises the main chat', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 0)
  D.stepStarted(store, 'a1', { effort: 'low', model: 'claude-haiku-5-5' }, 0)
  const fail = (id: string, at: number) => {
    D.toolStarted(store, 'a1', { id, tool: 'Bash', label: 'run tests', since: at, limitMs: 120_000 }, at)
    return D.toolEnded(store, 'a1', id, true, at + 500, 'Exit code 1')
  }
  expect(fail('c1', 1_000)).toBe(null)
  D.toolStarted(store, 'a1', { id: 'ok', tool: 'Bash', label: 'ls', since: 2_000, limitMs: 120_000 }, 2_000)
  D.toolEnded(store, 'a1', 'ok', false, 2_100)
  expect(fail('c2', 3_000)).toBe(null)
  const raised = fail('c3', 4_000)
  expect(raised).toContain('low → medium')
  const row = store.agents.get('a1')
  if (!row) throw new Error('no row')
  expect(row.effort).toBe('medium')
  expect(row.baseEffort).toBe('low')
  expect(D.effortToSend(store, 'a1', 'low')).toBe('medium')
  expect(D.effortToSend(store, 'a1', 'high')).toBe(undefined)
  D.stepStarted(store, 'a1', { effort: 'low', model: 'claude-haiku-5-5' }, 5_000)
  expect(row.effort).toBe('medium')
  for (const [i, id] of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'].entries()) fail(id, 6_000 + i * 1_000)
  expect(row.effort).toBe('max')
  expect(store.feed.filter(item => item.kind === 'up').length).toBe(4)

  D.stepStarted(store, undefined, { effort: 'max', model: 'opus' }, 0)
  D.toolStarted(store, undefined, { id: 'm1', tool: 'Bash', label: 'x', since: 0, limitMs: 120_000 }, 0)
  D.toolEnded(store, undefined, 'm1', true, 10)
  D.toolStarted(store, undefined, { id: 'm2', tool: 'Bash', label: 'x', since: 20, limitMs: 120_000 }, 20)
  expect(D.toolEnded(store, undefined, 'm2', true, 30)).toBe(null)

  const off = D.createStore()
  off.autoEscalate = false
  D.spawned(off, facts('b1'), 0)
  D.stepStarted(off, 'b1', { effort: 'low', model: 'haiku' }, 0)
  for (const id of ['e1', 'e2', 'e3']) {
    D.toolStarted(off, 'b1', { id, tool: 'Bash', label: 'x', since: 0, limitMs: 120_000 }, 0)
    D.toolEnded(off, 'b1', id, true, 10)
  }
  expect(off.agents.get('b1')?.effort).toBe('low')
})

test('guard refusals are counted by guard and land in the feed', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 0)
  D.toolStarted(store, 'a1', { id: 'g1', tool: 'Bash', label: 'find ruff', since: 0, limitMs: 120_000 }, 0)
  D.toolEnded(store, 'a1', 'g1', true, 10, 'Blocked by the search guard: `find / -name ruff` searches the whole disk')
  expect(store.guards.search).toBe(1)
  expect(store.feed.some(item => item.kind === 'guard' && item.text.includes('search guard'))).toBe(true)
})

test('the status capture gives account usage always, and cost only for this session', () => {
  const store = D.createStore()
  const status = (session: string) =>
    JSON.stringify({
      session_id: session,
      rate_limits: { five_hour: { used_percentage: 40, resets_at: 1792545000 }, seven_day: { used_percentage: 39, resets_at: 1792825200 } },
      cost: { total_cost_usd: 20.75 },
      context_window: { used_percentage: 64 },
    })
  D.absorbStatus(store, status('someone-else'), 'mine')
  expect(store.usage?.fiveHour?.pct).toBe(40)
  expect(store.usage?.fiveHour?.resetsAt).toBe(1792545000 * 1000)
  expect(store.usage?.costUsd).toBe(null)
  D.absorbStatus(store, status('mine'), 'mine')
  expect(store.usage?.costUsd).toBe(20.75)
  expect(store.usage?.ctxPct).toBe(64)
  D.absorbStatus(store, 'not json', 'mine')
  expect(store.usage?.sevenDay?.pct).toBe(39)
})

test('the timeline halves its resolution past the cap and keeps the stronger state', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 0)
  const row = store.agents.get('a1')
  if (!row) throw new Error('no row')
  for (let t = 0; t < 2_000_000; t += 1_000) {
    if (t === 1_000_000) D.toolStarted(store, 'a1', { id: 'b1', tool: 'Bash', label: 'x', since: t, limitMs: null }, t)
    D.sample(store, row, D.displayCode(row, t), t)
  }
  expect(row.tl.codes.length).toBeLessThan(481)
  expect(row.tl.size).toBeGreaterThan(2_000)
  expect(row.tl.codes.includes('l')).toBe(true)
})

test('a strip leaves the time before an agent started blank', () => {
  const store = D.createStore()
  D.spawned(store, facts('a1'), 50_000)
  const row = store.agents.get('a1')
  if (!row) throw new Error('no row')
  for (let t = 50_000; t <= 100_000; t += 1_000) D.sample(store, row, 't', t)
  const strip = D.cells(row, 0, 100_000, 20, 100_000)
  expect(strip.slice(0, 9).every(c => c === null)).toBe(true)
  expect(strip.slice(11).every(c => c === 't')).toBe(true)
})

test('the drawing helpers fill the cells they promise', () => {
  expect(bigWidth('62%')).toBe(11)
  expect(bigWidth('9.2k')).toBe(13)
  const half = meter(10, 0.5, 0xff0000)
  let full = 0
  for (let x = 0; x < 10; x++) if (half.words[x * 3] === 0x2588 && half.words[x * 3 + 1] === 0xff0000) full += 1
  expect(full).toBe(5)
  const bar = stacked(10, [
    { value: 1, color: 1 },
    { value: 1, color: 2 },
    { value: 1, color: 3 },
  ])
  const colors = Array.from({ length: 10 }, (_, x) => bar.words[x * 3 + 1])
  expect(colors.filter(c => c === 1).length + colors.filter(c => c === 2).length + colors.filter(c => c === 3).length).toBe(10)
  const line = spark(4, 2, [0, 1, 2, 4], () => 7)
  expect(line.words[(0 * 4 + 3) * 3]).toBe(0x2588)
  expect(line.words[(1 * 4 + 0) * 3]).toBe(0x20)
})

test('labels come from the parts of a call worth reading', () => {
  expect(D.workflowName("export const meta = {\n  name: 'drive-review',\n  description: 'x' }")).toBe('drive-review')
  expect(D.toolLabel({ tool: 'Bash', command: 'sleep 5', description: 'Nap briefly' })).toBe('Nap briefly')
  expect(D.toolLabel({ tool: 'Write', file_path: '/home/k/code/fun/video/out/review.md' })).toBe('…/out/review.md')
  expect(D.toolLimit({ tool: 'Bash', command: 'x' })).toBe(120_000)
  expect(D.toolLimit({ tool: 'Bash', command: 'x', run_in_background: true })).toBe(null)
  expect(D.targetOf('{"file_path":"/a/b/c/spec.md","content":"# Sp')).toBe('…/c/spec.md')
  expect(D.targetOf('{"command":"python3 - <<EOF\\nprint(1)')).toBe('')
  expect(D.modelShort('claude-sonnet-5-5')).toBe('sonnet')
  expect(D.modelShort('claude-opus-5-5[1m]')).toBe('opus')
})

test('the pane follows a workflow agent through thinking, writing and a long command', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const mirrored: { path: string; text: string }[] = []
  on('session.id', () => ({ value: 'test-session' }))
  const made: string[] = []
  claudeTemp(on, made)
  on('fs.write', (_, e) => {
    mirrored.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('tool.call', async () => {
    await clock.sleep(100_000)
    return { result: {} }
  })
  on('turn.step', async function* () {
    await clock.sleep(20_000)
    yield { kind: 'tool', index: 0, id: 'toolu_w', name: 'Write' }
    yield { kind: 'input', index: 0, json: '{"file_path":"/home/k/proj/specs/camera.md","content":"' }
    yield { kind: 'input', index: 0, json: 'x'.repeat(30_000) }
    await clock.sleep(5_000)
    yield { kind: 'stop', stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 9_000, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' } }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnInput('review:world', { runId: 'wf_test', agentIndex: 1 }))

  const drain = async () => {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3, agentId: 'a1' })) {
      void _
    }
  }
  const stepping = drain()
  await clock.advance(10_000)
  const thinking = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await thinking.find({ text: /thinking/ })).toBeDefined()
  expect(await thinking.find({ text: /opus·xhi/ })).toBeDefined()
  expect(await thinking.find({ text: /RUN/ })).toBeDefined()
  expect(await thinking.find({ text: /LIVE/ })).toBeDefined()
  await thinking.unmount()

  await clock.advance(12_000)
  const writing = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await writing.find({ text: /camera\.md/ }))?.text).toContain('29.4 KB')
  await writing.unmount()

  await clock.advance(10_000)
  await stepping
  const stepped = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await stepped.find({ text: /302k/ })).toBeDefined()
  expect(await stepped.find({ text: /THROUGHPUT/ })).toBeDefined()
  await stepped.unmount()

  // This call names no agent, so it runs on the main loop.
  const running = $.tool.call({ tool: 'Bash', command: 'sleep 600', description: 'Render 12 stills', timeout: 120_000 })
  await clock.advance(70_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Render 12 stills/ })).toBeDefined()
    expect(await ui.find({ text: /1:10 \/ 2:00/ })).toBeDefined()
    expect(await ui.find({ text: /review:world/ })).toBeDefined()
    expect(await ui.find({ text: /FEED/ })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(40_000)
  await running

  const last = mirrored[mirrored.length - 1]
  expect(last?.path).toBe('/tmp/claude-1000/mission-control-test-session.json')
  expect(made).toEqual(['mkdir -p -m 700 /tmp/claude-1000'])
  const deck = JSON.parse(last?.text ?? '{}') as { agents?: { label: string; effort: string | null; runId: string | null }[] }
  expect(deck.agents?.[0]?.label).toBe('review:world')
  expect(deck.agents?.[0]?.effort).toBe('xhigh')
  expect(deck.agents?.[0]?.runId).toBe('wf_test')
})

const SPRINT_JOURNAL = '/t/s/subagents/workflows/wf_sprint/journal.jsonl'
const jline = (o: unknown) => `${JSON.stringify(o)}\n`
const SPRINT_TICKETS = [
  { id: 'T1', title: 'Split the pane file', kind: 'routine', dependsOn: [], estimateMin: 4 },
  { id: 'T2', title: 'Journal reader', kind: 'judgment', dependsOn: ['T1'], estimateMin: 6 },
  { id: 'T3', title: 'Forecast model', kind: 'hard', dependsOn: ['T2'], estimateMin: 9 },
  { id: 'T4', title: 'Headline words', kind: 'routine', dependsOn: ['T2'], estimateMin: 4 },
]
const SPRINT_AGENTS: [string, string][] = [
  ['p1', 'plan (top·high)'],
  ['c1', 'plan critic (top·high)'],
  ['b1', 'T1 build 1/3 (haiku·low)'],
  ['r1', 'T1 review 1/3 (sonnet·high)'],
  ['b2', 'T2 build 1/3 (sonnet·medium)'],
]
const sprintJournal =
  jline({ type: 'launched' }) +
  SPRINT_AGENTS.map(([agentId, label]) => jline({ type: 'started', agentId, label, phase: 'p', key: agentId })).join('') +
  jline({ type: 'result', agentId: 'p1', key: 'p1', result: { tickets: SPRINT_TICKETS } }) +
  jline({ type: 'result', agentId: 'c1', key: 'c1', result: { tickets: SPRINT_TICKETS, changes: [] } }) +
  jline({ type: 'result', agentId: 'r1', key: 'r1', result: { pass: true, issues: [], summary: 'split is clean' } })

// An earlier sprint in the same session, finished and shipped before wf_sprint starts.
const DONE_JOURNAL = '/t/s/subagents/workflows/wf_done/journal.jsonl'
const DONE_TICKETS = [
  { id: 'T1', title: 'Rename the tiles', kind: 'mechanical', dependsOn: [], estimateMin: 3 },
  { id: 'T2', title: 'Trim the feed', kind: 'routine', dependsOn: ['T1'], estimateMin: 4 },
]
const DONE_AGENTS: [string, string][] = [
  ['dp', 'plan (top·high)'],
  ['dc', 'plan critic (top·high)'],
  ['db1', 'T1 build 1/3 (haiku·low)'],
  ['dr1', 'T1 review 1/3 (sonnet·high)'],
  ['db2', 'T2 build 1/3 (haiku·low)'],
  ['dr2', 'T2 review 1/3 (sonnet·high)'],
  ['di', 'integrate (top·high)'],
  ['df', 'final review (top·high)'],
]
const doneJournal =
  jline({ type: 'launched' }) +
  DONE_AGENTS.map(([agentId, label]) => jline({ type: 'started', agentId, label, phase: 'p', key: agentId })).join('') +
  jline({ type: 'result', agentId: 'dp', key: 'dp', result: { tickets: DONE_TICKETS } }) +
  jline({ type: 'result', agentId: 'dc', key: 'dc', result: { tickets: DONE_TICKETS, changes: [] } }) +
  jline({ type: 'result', agentId: 'dr1', key: 'dr1', result: { pass: true, issues: [], summary: 'tiles read well' } }) +
  jline({ type: 'result', agentId: 'dr2', key: 'dr2', result: { pass: true, issues: [], summary: 'feed is shorter' } }) +
  jline({ type: 'result', agentId: 'df', key: 'df', result: { verdict: 'ship', summary: 'ready to ship', issues: [] } })

async function sprintSession($: Engine, on: Parameters<TestBody>[1], earlier = false) {
  const clock = mock.clock(on, { now: 3_000_000 })
  const ids = [...(earlier ? DONE_AGENTS : []), ...SPRINT_AGENTS].map(([agentId]) => agentId)
  const journals = new Map<string, string>([[SPRINT_JOURNAL, sprintJournal]])
  if (earlier) journals.set(DONE_JOURNAL, doneJournal)
  const journal = (path: string) => {
    const text = journals.get(path)
    if (text === undefined) throw new Error('missing')
    return text
  }
  let next = 0
  on('session.id', () => ({ value: 's' }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ids[next++] ?? `x${next}` }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: journal(e.path).length, mtimeMs: 0, isLink: false } }))
  on('fs.read', (_, e) => ({ value: journal(e.path) }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  const end = (agentId: string) => $.turn.complete({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
  if (earlier) {
    for (const [i, [agentId, label]] of DONE_AGENTS.entries()) {
      await $.agent.spawn(spawnInput(label, { runId: 'wf_done', agentIndex: i + 1 }))
      await clock.advance(30_000)
      await end(agentId)
    }
    await clock.advance(20_000)
  }
  const runFor = [60_000, 60_000, 120_000, 60_000, 30_000]
  for (const [i, [agentId, label]] of SPRINT_AGENTS.entries()) {
    await $.agent.spawn(spawnInput(label, { runId: 'wf_sprint', agentIndex: i + 1 }))
    await clock.advance(runFor[i] ?? 10_000)
    if (agentId !== 'b2') await end(agentId)
  }
  await clock.advance(4_000)
  return clock
}

test('a sprint draws its headline, flight plan and map at every width, with no lane agent as a NOW card', async ($, on) => {
  await sprintSession($, on)
  for (const width of [60, 84, 110]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: width } })
      const where = `${surface} at ${width}`
      expect(await ui.find({ text: /FLIGHT PLAN/ }), where).toBeDefined()
      expect(await ui.find({ text: /Journal reader|Split the pane/ }), where).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /passed|Waiting on/ }), where).toBeDefined()
      if (width >= 84) {
        expect(await ui.find({ text: /PASSED/ }), where).toBeDefined()
        expect(await ui.find({ text: /SPRINT MAP/ }), where).toBeDefined()
      }
      const rasters = await ui.findAll({ type: 'Raster' })
      if (surface === 'terminal') {
        expect(rasters.length > 0, where).toBe(true)
        for (const r of rasters) expect((r.props['columns'] as number) <= width, `${where}: raster ${r.key}`).toBe(true)
      } else {
        expect(rasters.length, where).toBe(0)
      }
      expect(await ui.find({ key: 'open-b2' }), where).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^ +T2 build 1\/3 [^(]/ }), where).toBeDefined()
      await ui.unmount()
    }
  }
})

test('stepping back into a sprint shows REPLAY and draws the sprint as of the cursor', async ($, on) => {
  await sprintSession($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /REPLAY/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Waiting on T2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ +T2 build 1\/3 [^(]/ })).toBeDefined()
    for (let i = 0; i < 4; i++) await ui.press({ key: 'back' })
    await ui.unmount()
    const replaying = await $.ui.mount({ ...PANE, surface })
    expect(await replaying.find({ text: /REPLAY/ })).toBeDefined()
    expect(await replaying.find({ key: 'live' })).toBeDefined()
    expect(await replaying.find({ type: 'Text', text: /^Waiting on T1/ })).toBeDefined()
    expect(await replaying.find({ type: 'Text', text: /^ +T\d (build|review)/ })).toBeUndefined()
    await replaying.press({ key: 'live' })
    await replaying.unmount()
  }
})

test('a finished sprint and a live one draw both flight plans, each Raster drawn once', async ($, on) => {
  await sprintSession($, on, true)
  for (const width of [60, 84, 110]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: width } })
      const where = `${surface} at ${width}`
      const done = await ui.find({ key: 'flight-wf_done' })
      const live = await ui.find({ key: 'flight-wf_sprint' })
      expect(done?.text ?? '', `${where}: finished plan`).toContain('2 of 2 passed')
      expect(done?.text ?? '', `${where}: finished plan`).toContain('Rename')
      expect(live?.text ?? '', `${where}: live plan`).toContain('Split')
      expect(live?.text ?? '', `${where}: live plan`).toContain('T4')
      expect(await ui.find({ type: 'Text', text: /^Waiting on T2/ }), where).toBeDefined()
      const rasters = await ui.findAll({ type: 'Raster' })
      if (surface === 'terminal') {
        const keys = rasters.map(r => r.key)
        expect(new Set(keys).size, `${where}: ${keys.join(' ')}`).toBe(keys.length)
        expect(keys.includes('flight-strips'), where).toBe(true)
        for (const r of rasters) expect((r.props['columns'] as number) <= width, `${where}: raster ${r.key}`).toBe(true)
      } else {
        expect(rasters.length, where).toBe(0)
      }
      await ui.unmount()
    }
  }
  const shown = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await shown.press({ key: 'done' })
  await shown.unmount()
  const hidden = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await hidden.find({ key: 'flight-wf_done' })).toBeUndefined()
  expect(await hidden.find({ type: 'Text', text: /\(hidden\)$/ })).toBeDefined()
  expect(await hidden.find({ key: 'flight-wf_sprint' })).toBeDefined()
  await hidden.unmount()
})

test('ten minutes after a sprint ends, a plain subagent leads the pane and the old plan sits below it', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  const ids = [...DONE_AGENTS.map(([agentId]) => agentId), 'loose1']
  let next = 0
  on('session.id', () => ({ value: 's' }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ids[next++] ?? `x${next}` }))
  on('fs.stat', (_, e) => {
    if (e.path !== DONE_JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: doneJournal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== DONE_JOURNAL) throw new Error('missing')
    return { value: doneJournal }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  for (const [i, [agentId, label]] of DONE_AGENTS.entries()) {
    await $.agent.spawn(spawnInput(label, { runId: 'wf_done', agentIndex: i + 1 }))
    await clock.advance(30_000)
    await $.turn.complete({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
  }
  await clock.advance(10 * 60_000)
  await $.agent.spawn({ ...spawnInput('loose helper'), subagentType: 'Explore' })
  await clock.advance(5_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 84 } })
  expect(await ui.find({ text: /sprint done/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^LIVE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STUCK$/ })).toBeDefined()
  const all = await ui.findAll({})
  const at = (hit: (n: { key?: string | null; text?: string }) => boolean) => all.findIndex(hit)
  const now = at(n => /^NOW/.test(n.text ?? ''))
  const plan = at(n => n.key === 'flight-wf_done')
  expect(now, 'NOW section drawn').toBeGreaterThanOrEqual(0)
  expect(plan, 'old flight plan drawn').toBeGreaterThanOrEqual(0)
  expect(now).toBeLessThan(plan)
  await ui.unmount()
})

test('the pane keeps working where the host cannot say the session id', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a9' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ ...spawnInput('loose helper'), subagentType: 'Explore' })
  await clock.advance(3_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /loose helper/ })).toBeDefined()
  expect(await ui.find({ text: /SUBAGENTS/ })).toBeDefined()
  await ui.unmount()
})

test('an empty session says what will show up', async ($, on) => {
  mock.clock(on, { now: 5_000 })
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /show up here the moment they start/ })).toBeDefined()
    await ui.unmount()
  }
})

async function doneSession($: Engine, on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on, { now: 3_000_000 })
  let next = 0
  on('session.id', () => ({ value: 's' }))
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: DONE_AGENTS[next++]?.[0] ?? `x${next}` }))
  on('fs.stat', (_, e) => {
    if (e.path !== DONE_JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: doneJournal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.path !== DONE_JOURNAL) throw new Error('missing')
    return { value: doneJournal }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
  for (const [i, [agentId, label]] of DONE_AGENTS.entries()) {
    await $.agent.spawn(spawnInput(label, { runId: 'wf_done', agentIndex: i + 1 }))
    await clock.advance(30_000)
    await $.turn.complete({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
  }
  await clock.advance(60_000)
  return clock
}

test('fwd at the end of a finished run keeps the replay at its end instead of going live', async ($, on) => {
  await doneSession($, on)
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await first.find({ text: /REPLAY/ })).toBeUndefined()
  for (let i = 0; i < 3; i++) await first.press({ key: 'back' })
  await first.unmount()
  for (let i = 0; i < 60; i++) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'next' })
    await ui.unmount()
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const at = await $.ui.mount({ ...PANE, surface })
    expect(await at.find({ text: /REPLAY/ }), surface).toBeDefined()
    expect(await at.find({ key: 'live' }), surface).toBeDefined()
    await at.unmount()
  }
  const last = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await last.press({ key: 'live' })
  await last.unmount()
  const live = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await live.find({ text: /REPLAY/ })).toBeUndefined()
  await live.unmount()
})

test('a refused first open does not throw out of the spawn', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  const asked: unknown[] = []
  on('command.register', () => ({ value: { command: 'mission-control' } }))
  on('ui.open', (_, e) => {
    asked.push(e)
    throw new Error('no room')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a9' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spawned = await $.agent.spawn({ ...spawnInput('loose helper'), subagentType: 'Explore' })
  await clock.advance(3_000)
  expect(spawned.agentId).toBe('a9')
  expect(asked).toEqual([{ id: 'mission-control', title: 'Mission Control', columns: 84, rows: 40 }])
})

const MIRROR_CASES: [string, string | null, string[]][] = [
  ['a private folder of this account', '1000 700\n', ['/tmp/claude-1000/mission-control-s.json']],
  ['a folder another account owns', '0 700\n', []],
  ['a folder others can read', '1000 755\n', []],
  ['a host that cannot make the folder', null, []],
]
for (const [name, seen, expected] of MIRROR_CASES) {
  test(`the mirror never lands in bare /tmp: ${name}`, async ($, on) => {
    const writes = new Set<string>()
    const clock = mock.clock(on, { now: 2_000_000 })
    on('session.id', () => ({ value: 's' }))
    if (seen === null) on('process.run', () => run('', 1))
    else claudeTemp(on, [], seen)
    on('fs.write', (_, e) => {
      writes.add(e.path)
      return { value: undefined }
    })
    on('command.register', () => ({ value: { command: 'mission-control' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a9' }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.agent.spawn({ ...spawnInput('loose helper'), subagentType: 'Explore' })
    await clock.advance(3_000)
    expect([...writes].filter(path => /^\/tmp\/[^/]+$/.test(path))).toEqual([])
    expect([...writes]).toEqual(expected)
  })
}

// The reviewer ends before its verdict reaches the journal; the journal gets it a moment after.
for (const pause of [0, 1_000, 2_000]) {
  test(`a review verdict written just after the reviewer ends shows within a few beats (start offset ${pause} ms)`, async ($, on) => {
    const clock = mock.clock(on, { now: 3_000_000 })
    const without = sprintJournal.slice(0, sprintJournal.lastIndexOf(jline({ type: 'result', agentId: 'r1', key: 'r1', result: { pass: true, issues: [], summary: 'split is clean' } })))
    let text = without
    const ids = SPRINT_AGENTS.map(([agentId]) => agentId)
    let next = 0
    on('session.id', () => ({ value: 's' }))
    on('command.register', () => ({ value: { command: 'mission-control' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: {} }))
    on('turn.complete', () => ({ text: '' }))
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ids[next++] ?? `x${next}` }))
    on('fs.stat', (_, e) => {
      if (e.path !== SPRINT_JOURNAL) throw new Error('missing')
      return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
    })
    on('fs.read', (_, e) => {
      if (e.path !== SPRINT_JOURNAL) throw new Error('missing')
      return { value: text }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'true', description: 'x', transcript_path: '/t/s.jsonl' } as never)
    const end = (agentId: string) => $.turn.complete({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never)
    for (const [i, [agentId, label]] of SPRINT_AGENTS.slice(0, 4).entries()) {
      await $.agent.spawn(spawnInput(label, { runId: 'wf_sprint', agentIndex: i + 1 }))
      await clock.advance(i === 3 ? 60_000 + pause : 60_000)
      if (agentId !== 'r1') await end(agentId)
    }
    await end('r1')
    const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await before.find({ type: 'Text', text: /0 of 4 passed/ })).toBeDefined()
    await before.unmount()
    text = sprintJournal
    await clock.advance(1_000)
    const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await after.find({ type: 'Text', text: /^Waiting on T1/ })).toBeUndefined()
    expect(await after.find({ type: 'Text', text: /1 of 4 passed/ })).toBeDefined()
    await after.unmount()
  })
}
