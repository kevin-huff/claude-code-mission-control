import { expect, test } from 'claude-code/testing'

import type { AgentRow, Attempt, Forecast, Lane, LaneStatus, RunRow, Sprint, SprintStage, Usage } from '../types'
import * as D from '../hooks/deck'
import { burn, headline } from '../hooks/headline'

const MIN = 60000
const T0 = 1_800_000_000_000

function row(id: string, label: string, startedAt: number, endedAt: number | null = null): AgentRow {
  const store = D.createStore()
  D.spawned(store, { agentId: id, description: label, subagentType: 'workflow-subagent', model: 'claude-opus-5-5', runId: 'wf_h', index: 1, toolUseId: 'toolu_h', isTeammate: false }, startedAt)
  const r = store.agents.get(id)!
  r.startedAt = startedAt
  r.endedAt = endedAt
  return { ...r }
}

function lane(id: string, status: LaneStatus, o: Partial<Lane> = {}): Lane {
  return { id, title: `title of ${id}`, kind: 'routine', dependsOn: [], estimateMin: 4, status, attempts: [], maxAttempts: 3, startedAt: null, endedAt: null, tokens: 0, live: null, ...o }
}

function attempt(tier: string, buildAt: number): Attempt {
  return { n: 1, tier, rung: 2, build: row(`b-${buildAt}`, `T3 build 1/3 (${tier})`, buildAt), review: null, verdict: null }
}

function sprint(stage: SprintStage, lanes: Lane[], o: Partial<Sprint> = {}): Sprint {
  return { runId: 'wf_h', name: 'sprint', startedAt: T0, endedAt: null, at: T0 + 20 * MIN, round: 0, stage, draft: false, lanes, deciders: [], closers: [], final: null, tokens: 0, previous: null, ...o }
}

function forecast(o: Partial<Forecast> = {}): Forecast {
  return { at: T0 + 20 * MIN, factor: 1, projections: {}, criticalPath: [], longPole: null, waiting: [], buildEnd: null, eta: null, ...o }
}

const CLOCK = /\d{1,2}:\d{2} ?(am|pm|AM|PM)/

function plain(text: string) {
  expect(CLOCK.test(text)).toBe(false)
  expect(/\bat \d{1,2}(:\d{2})?\b/.test(text)).toBe(false)
}

test('planning says how long the planner has worked', () => {
  const planner = row('p1', 'plan (top·high)', T0)
  const text = headline(sprint('deciding', [], { at: T0 + 125000, deciders: [planner] }), forecast())
  expect(text).toBe('Planning: the planner has worked 2:05')
  plain(text)
})

test('a draft plan reads as the critic checking it, with the ticket count', () => {
  const planner = row('p1', 'plan (top·high)', T0, T0 + 5 * MIN)
  const critic = row('c1', 'plan critic (top·high)', T0 + 5 * MIN)
  const lanes = [lane('T1', 'waiting'), lane('T2', 'waiting'), lane('T3', 'waiting')]
  const text = headline(sprint('deciding', lanes, { draft: true, at: T0 + 7 * MIN, deciders: [planner, critic] }), forecast())
  expect(text).toContain('Checking the plan')
  expect(text).toContain('the critic has worked 2:00')
  expect(text).toContain('the draft has 3 tickets')
})

test('a finished planner counts its own run time', () => {
  const planner = row('p1', 'plan (top·high)', T0, T0 + 90000)
  expect(headline(sprint('deciding', [], { at: T0 + 10 * MIN, deciders: [planner] }), forecast())).toBe('Planning: the planner has worked 1:30')
})

test('building names the ticket the run waits on, its tier and what is behind it', () => {
  const s = sprint('building', [
    lane('T1', 'passed'),
    lane('T3', 'building', { attempts: [attempt('top·high', T0 + 12 * MIN)] }),
    lane('T4', 'waiting', { dependsOn: ['T3'] }),
    lane('T5', 'waiting', { dependsOn: ['T3'] }),
    lane('T6', 'waiting', { dependsOn: ['T4'] }),
  ])
  const f = forecast({ longPole: 'T3', waiting: [{ on: 'T3', blocked: ['T4', 'T5', 'T6'] }], eta: T0 + 38 * MIN + 20000 })
  const text = headline(s, f)
  expect(text).toBe('Waiting on T3 (top·high, 8:00 in) · 3 tickets behind it · 1 of 5 passed · about 18 min left · title of T3')
  plain(text)
})

test('one ticket behind the pole reads in the singular, and a lane with no attempt has no parenthesis', () => {
  const s = sprint('building', [lane('T1', 'ready'), lane('T2', 'waiting', { dependsOn: ['T1'] })])
  const text = headline(s, forecast({ longPole: 'T1', waiting: [{ on: 'T1', blocked: ['T2'] }] }))
  expect(text).toBe('Waiting on T1 · 1 ticket behind it · 0 of 2 passed · title of T1')
})

test('building with no pole shows progress, workers and the longest chain', () => {
  const s = sprint('building', [
    lane('T1', 'passed'), lane('T2', 'building'), lane('T3', 'reviewing'), lane('T4', 'waiting'),
  ])
  const text = headline(s, forecast({ criticalPath: ['T1', 'T2', 'T4'], eta: s.at + 18 * MIN }))
  expect(text).toBe('1 of 4 passed · 2 working · longest chain T1 → T2 → T4 · about 18 min left')
})

test('a chain of six ids is shortened to the first two, an ellipsis and the last', () => {
  const s = sprint('building', [lane('T1', 'building')])
  const text = headline(s, forecast({ criticalPath: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] }))
  expect(text).toContain('longest chain T1 → T2 → … → T6')
  expect(text).not.toContain('T3')
  const four = headline(s, forecast({ criticalPath: ['T1', 'T2', 'T3', 'T4'] }))
  expect(four).toContain('T1 → T2 → T3 → T4')
})

test('time left is rounded, never less than one minute, and left out without an estimate', () => {
  const s = sprint('building', [lane('T1', 'building')])
  expect(headline(s, forecast({ eta: s.at + 10000 }))).toContain('about 1 min left')
  expect(headline(s, forecast({ eta: s.at - 5 * MIN }))).toContain('about 1 min left')
  expect(headline(s, forecast({ eta: s.at + 4.6 * MIN }))).toContain('about 5 min left')
  expect(headline(s, forecast({ eta: null }))).not.toContain('min left')
})

test('integrating counts settled tickets and how long the integrator has run', () => {
  const lanes = [...Array(12)].map((_, i) => lane(`T${i + 1}`, 'passed')).concat(lane('T13', 'failed'))
  const closer = row('i1', 'integrate (top·high)', T0 + 18 * MIN)
  const text = headline(sprint('integrating', lanes, { closers: [closer] }), forecast({ eta: T0 + 26 * MIN }))
  expect(text).toBe('Tickets settled: 12 passed, 1 failed · integrating 2:00 · about 6 min left')
})

test('the final review shows its run time', () => {
  const closer = row('r1', 'final review (top·max)', T0 + 15 * MIN)
  const text = headline(sprint('reviewing', [lane('T1', 'passed')], { closers: [closer] }), forecast({ eta: T0 + 28 * MIN }))
  expect(text).toBe('Final review running 5:00 · about 8 min left')
})

test('done reports the total, the chain that took longest, the estimate error and the verdict', () => {
  const lanes = [
    lane('T1', 'passed', { startedAt: T0 + 5 * MIN, endedAt: T0 + 15 * MIN }),
    lane('T2', 'passed', { startedAt: T0 + 15 * MIN, endedAt: T0 + 35 * MIN }),
    lane('T3', 'failed'),
  ]
  const s = sprint('done', lanes, { endedAt: T0 + 3725000, final: { verdict: 'ship', summary: 'fine' } })
  const text = headline(s, forecast({ factor: 1.4, criticalPath: ['T1', 'T2'], eta: null }))
  expect(text).toBe('Final review: ship · finished in 1:02:05 · 2 of 3 passed · longest chain T1 → T2 took 30:00 · tickets took 1.4× their estimates on average')
  plain(text)
  expect(text).not.toContain('min left')
})

test('the verdict stays inside the first 60 columns of a long done headline', () => {
  for (const verdict of ['ship', 'fix first']) {
    const lanes = [
      lane('T1', 'passed', { startedAt: T0 + 5 * MIN, endedAt: T0 + 15 * MIN }),
      lane('T2', 'passed', { startedAt: T0 + 15 * MIN, endedAt: T0 + 35 * MIN }),
      lane('T3', 'failed'),
    ]
    const s = sprint('done', lanes, { endedAt: T0 + 3725000, final: { verdict, summary: 'x' } })
    const text = headline(s, forecast({ factor: 1.4, criticalPath: ['T1', 'T2'], eta: null }))
    expect(text.indexOf(`Final review: ${verdict}`) + `Final review: ${verdict}`.length).toBeLessThanOrEqual(60)
  }
})

test('done says short when estimates ran under, and leaves out parts it cannot fill', () => {
  const lanes = [lane('T1', 'passed', { startedAt: null, endedAt: T0 + MIN })]
  const s = sprint('done', lanes, { endedAt: T0 + 10 * MIN })
  const text = headline(s, forecast({ factor: 0.8, criticalPath: ['T1'] }))
  expect(text).toBe('Finished in 10:00 · 1 of 1 passed · longest chain T1 · tickets took 0.8× their estimates on average')
  expect(headline(s, forecast({ factor: 1 }))).toBe('Finished in 10:00 · 1 of 1 passed')
})

test('no stage prints a clock time of day', () => {
  const stages: SprintStage[] = ['deciding', 'building', 'integrating', 'reviewing', 'done']
  for (const stage of stages) {
    const s = sprint(stage, [lane('T1', 'passed', { startedAt: T0, endedAt: T0 + MIN })], { endedAt: T0 + 5 * MIN, final: { verdict: 'ship', summary: '' } })
    plain(headline(s, forecast({ criticalPath: ['T1'], eta: T0 + 30 * MIN, factor: 1.2 })))
  }
})

function run(o: Partial<RunRow> = {}): RunRow {
  return { id: 'wf_h', name: 'sprint', dir: null, startedAt: T0, endedAt: null, phases: {}, plan: null, draft: null, planFrom: null, verdicts: {}, final: null, finals: {}, maxTickets: null, limitBase: { pct: 20, resetsAt: T0 + 3 * 3600000 }, ...o }
}

function usage(pct: number, resetsAt = T0 + 3 * 3600000): Usage {
  return { fiveHour: { pct, resetsAt }, sevenDay: null, costUsd: null, ctxPct: null }
}

test('burn is null without a base, without current usage, or in the first minute', () => {
  const at = T0 + 30 * MIN
  expect(burn(run({ limitBase: null }), usage(30), forecast(), at)).toBe(null)
  expect(burn(run(), null, forecast(), at)).toBe(null)
  expect(burn(run(), { ...usage(30), fiveHour: null }, forecast(), at)).toBe(null)
  expect(burn(run(), usage(30), forecast(), T0 + 59000)).toBe(null)
  expect(burn(run(), usage(30), forecast(), T0 + 60000)).not.toBe(null)
})

test('burn says so when the limit window reset during the sprint', () => {
  const b = burn(run(), usage(5, T0 + 8 * 3600000), forecast(), T0 + 30 * MIN)
  expect(b).toEqual({ text: 'Your 5-hour limit window reset during this sprint', level: 'ok' })
  const near = burn(run(), usage(25, T0 + 3 * 3600000 + MIN), forecast(), T0 + 30 * MIN)
  expect(near?.text).toContain('20% → 25%')
})

test('burn projects the percentage at the end: ok under 80, warn from 80', () => {
  const at = T0 + 30 * MIN
  const ok = burn(run(), usage(30), forecast({ eta: at + 30 * MIN }), at)
  expect(ok).toEqual({ text: '5-hour limit about 40% by the end · 20% → 30% so far', level: 'ok' })
  const warn = burn(run(), usage(40), forecast({ eta: at + 45 * MIN }), at)
  expect(warn?.text).toContain('20% → 40%')
  expect(warn?.text).toContain('about 70% by the end')
  expect(warn?.level).toBe('ok')
  const hot = burn(run(), usage(40), forecast({ eta: at + 60 * MIN }), at)
  expect(hot?.text).toContain('about 80% by the end')
  expect(hot?.level).toBe('warn')
})

test('burn warns the limit will run out before the sprint ends', () => {
  const at = T0 + 30 * MIN
  const b = burn(run(), usage(50), forecast({ eta: at + 60 * MIN }), at)
  expect(b?.level).toBe('over')
  expect(b?.text).toBe('5-hour limit runs out in about 50 min, before the sprint ends · 20% → 50% so far')
  const soon = burn(run(), usage(99.9), forecast({ eta: at + 60 * MIN }), at)
  expect(soon?.text).toContain('about 1 min')
})

test('burn without a projection is plain and ok', () => {
  const at = T0 + 30 * MIN
  const noEta = burn(run(), usage(30), forecast({ eta: null }), at)
  expect(noEta).toEqual({ text: '5-hour limit 20% → 30% since this sprint started', level: 'ok' })
  const flat = burn(run(), usage(20), forecast({ eta: at + 30 * MIN }), at)
  expect(flat?.level).toBe('ok')
  expect(flat?.text).not.toContain('by the end')
  const past = burn(run(), usage(30), forecast({ eta: at - MIN }), at)
  expect(past?.text).not.toContain('by the end')
})

test('a fix plan reads as the triage agent planning fixes, timed from its own start', () => {
  const fix = row('f1', 'fix plan (top·high)', T0 + 10 * MIN)
  const text = headline(sprint('deciding', [], { at: T0 + 10 * MIN + 75000, deciders: [fix] }), forecast())
  expect(text.startsWith('Planning fixes: the triage agent has worked')).toBe(true)
  expect(text).toBe('Planning fixes: the triage agent has worked 1:15')
  plain(text)
})

test('a fix round after passed lanes shows the pass count and the fix plan time', () => {
  const planner = row('p1', 'plan (top·high)', T0, T0 + 2 * MIN)
  const fix = row('f1', 'fix plan (top·high)', T0 + 30 * MIN)
  const lanes = [lane('T1', 'passed'), lane('T2', 'passed'), lane('T3', 'failed')]
  const text = headline(sprint('deciding', lanes, { at: T0 + 30 * MIN + 45000, deciders: [planner, fix] }), forecast())
  expect(text).toBe('Planning fixes: the triage agent has worked 0:45 · 2 of 3 passed')
})

test('burn leads with the projection, and the runs-out phrase sits inside 84 characters', () => {
  const at = T0 + 30 * MIN
  const over = burn(run(), usage(50), forecast({ eta: at + 60 * MIN }), at)!
  expect(over.text.startsWith('5-hour limit runs out in about')).toBe(true)
  expect(over.text.indexOf('runs out in about') + 'runs out in about'.length).toBeLessThanOrEqual(84)
  const ok = burn(run(), usage(30), forecast({ eta: at + 30 * MIN }), at)!
  expect(ok.text.startsWith('5-hour limit about 40% by the end')).toBe(true)
})

test('Waiting on fits 60 characters, times from the build start and uses the reviewer tier', () => {
  const build = row('b1', 'T7 build 1/3 (sonnet·high)', T0 + 10 * MIN, T0 + 14 * MIN)
  const review = row('r1', 'T7 review 1/3 (top·high)', T0 + 14 * MIN)
  const att: Attempt = { n: 1, tier: 'sonnet·high', rung: 2, build, review, verdict: null }
  const s = sprint('building', [
    lane('T7', 'reviewing', { attempts: [att], live: review }),
    lane('T8', 'waiting', { dependsOn: ['T7'] }),
  ], { at: T0 + 14 * MIN + 10000 })
  const text = headline(s, forecast({ longPole: 'T7', waiting: [{ on: 'T7', blocked: ['T8'] }] }))
  expect(text.startsWith('Waiting on T7 (top·high, 4:10 in)')).toBe(true)
  expect(text.slice(0, 60)).toContain('(top·high, 4:10 in)')
  expect(text.endsWith('title of T7')).toBe(true)
})

test('a critic that is the newest decider is named, with the draft size', () => {
  const planner = row('p1', 'plan (top·high)', T0, T0 + 5 * MIN)
  const critic = row('c1', 'plan critic (top·high)', T0 + 5 * MIN)
  const lanes = [lane('T1', 'waiting'), lane('T2', 'waiting')]
  const text = headline(sprint('deciding', lanes, { at: T0 + 7 * MIN, deciders: [planner, critic] }), forecast())
  expect(text).toBe('Checking the plan: the critic has worked 2:00 · the draft has 2 tickets')
  const bare = headline(sprint('deciding', [], { at: T0 + 7 * MIN, deciders: [planner, critic] }), forecast())
  expect(bare).toBe('Checking the plan: the critic has worked 2:00')
})

test('fix rounds prefix building, integrating and reviewing', () => {
  const lanes = [lane('T1', 'passed'), lane('T2', 'building')]
  expect(headline(sprint('building', lanes, { round: 1 }), forecast())).toBe('Fix round 1 · 1 of 2 passed · 1 working')
  const integ = row('i1', 'integrate (top·high)', T0 + 18 * MIN)
  expect(headline(sprint('integrating', lanes, { round: 2, closers: [integ] }), forecast()).startsWith('Fix round 2 · Tickets settled')).toBe(true)
  const fr = row('r1', 'final review (top·max)', T0 + 15 * MIN)
  expect(headline(sprint('reviewing', lanes, { round: 1, closers: [fr] }), forecast()).startsWith('Fix round 1 · Final review running')).toBe(true)
  expect(headline(sprint('building', lanes, { round: 0 }), forecast()).startsWith('Fix round')).toBe(false)
})

test('several final reviewers are counted and timed by the longest-running one', () => {
  const a = row('r1', 'final review (top·max)', T0 + 15 * MIN)
  const b = row('r2', 'final review (top·max)', T0 + 17 * MIN)
  const text = headline(sprint('reviewing', [lane('T1', 'passed')], { closers: [a, b] }), forecast())
  expect(text).toBe('2 final reviewers running 5:00')
})

test('finished in never exceeds the run length when the deck time is later', () => {
  const s = sprint('done', [lane('T1', 'passed')], { endedAt: T0 + 10 * MIN, at: T0 + 60 * MIN })
  expect(headline(s, forecast({ eta: T0 + 90 * MIN }))).toContain('Finished in 10:00')
  const noEnd = sprint('done', [lane('T1', 'passed')], { endedAt: null, at: T0 + 60 * MIN })
  expect(headline(noEnd, forecast({ eta: T0 + 30 * MIN }))).toContain('Finished in 30:00')
})
