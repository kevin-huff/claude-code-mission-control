import { expect, mock, test } from 'claude-code/testing'
import type { Deck } from '../types'

const RUN = 'wf_nodir'
const JOURNAL = `/t/s/subagents/workflows/${RUN}/journal.jsonl`
const line = (o: unknown) => `${JSON.stringify(o)}\n`

const spawnInput = (description: string, agentIndex: number) => ({
  tool_use_id: 'toolu_wf',
  prompt: 'do it',
  description,
  subagentType: 'workflow-subagent',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  workflow: { runId: RUN, agentIndex },
})

const finish = (agentId: string) => ({ agentId, reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' }) as never

// Claude Code's tool calls carry no transcript path, so a run's folder is unknown until a prompt (or the session's
// start) brings the session's transcript path, like a run an older pane recorded. Then the run reads its journal
// in that folder and gets its ticket titles and verdicts.
test('a run without a folder reads its journal once a prompt brings the session folder', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const journal = [
    { type: 'launched' },
    { type: 'started', agentId: 'p1', label: 'plan (top·max)', phase: 'p', key: 'p1' },
    { type: 'result', agentId: 'p1', key: 'p1', result: { tickets: [{ id: 'T1', title: 'First ticket', kind: 'routine', dependsOn: [], estimateMin: 2 }] } },
    { type: 'started', agentId: 'b1', label: 'T1 build 1/3 (sonnet·medium)', phase: 'p', key: 'b1' },
    { type: 'result', agentId: 'b1', key: 'b1', result: { summary: 'built', changed: [] } },
    { type: 'started', agentId: 'r1', label: 'T1 review 1/3 (sonnet·high)', phase: 'p', key: 'r1' },
    { type: 'result', agentId: 'r1', key: 'r1', result: { pass: true, issues: [], summary: 'passes' } },
  ]
    .map(line)
    .join('')
  const ids = new Map([
    ['plan (top·max)', 'p1'],
    ['T1 build 1/3 (sonnet·medium)', 'b1'],
    ['T1 review 1/3 (sonnet·high)', 'r1'],
  ])
  const mirrored: string[] = []
  on('session.id', () => ({ value: 's' }))
  on('fs.stat', (_, e) => {
    if (e.path !== JOURNAL) throw new Error('missing')
    return { value: { kind: 'file', size: journal.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
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
  on('classic.UserPromptSubmit', () => ({}))
  on('agent.spawn', (_, e) => ({ model: 'claude-opus-5-5', agentId: ids.get(e.description) ?? 'x' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let index = 0
  for (const [label, id] of ids) {
    await $.agent.spawn(spawnInput(label, ++index))
    await clock.advance(60_000)
    await $.turn.complete(finish(id))
  }
  await $.tool.call({ tool: 'Bash', command: 'true', description: 'x' } as never)
  await clock.advance(10_000)
  const before = JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck
  expect(before.runs.find(r => r.id === RUN)?.dir, 'a tool call brings no folder').toBe(null)
  await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t/other-agent.jsonl' })
  await clock.advance(10_000)
  expect((JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck).transcriptDir, 'another transcript is not the session folder').toBe(null)
  await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t/s.jsonl' })
  await clock.advance(10_000)
  const run = (JSON.parse(mirrored[mirrored.length - 1] ?? '{}') as Deck).runs.find(r => r.id === RUN)
  expect(run?.dir, 'the run adopts the session folder').toBe('/t/s')
  expect(run?.plan?.map(t => t.title), 'the plan came from the journal').toEqual(['First ticket'])
  expect(Object.values(run?.verdicts ?? {}).map(v => v.pass), 'the review verdict came from the journal').toEqual([true])
})
