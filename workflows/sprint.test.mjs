import fs from 'node:fs'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

const src = fs.readFileSync(process.argv[2], 'utf8').replace(/^export const meta = /m, 'const meta = ')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = new AsyncFunction('agent', 'phase', 'log', 'budget', 'args', 'parallel', src)

// parallel() as the Workflow runtime documents it: every thunk starts at once in its own slot, a thunk that
// throws resolves to null, and the call waits for all of them. The slot path is kept so scenario T can see
// where each agent call lands.
const slot = new AsyncLocalStorage()
const parallel = thunks => Promise.all(thunks.map((fn, i) => slot.run([...(slot.getStore() || []), i], () => {
  try { return Promise.resolve(fn()).catch(() => null) } catch { return Promise.resolve(null) }
})))

const ticket = (id, kind, dependsOn = [], estimateMin) => ({ id, title: `ticket ${id}`, task: `do ${id}`, files: [`${id}.txt`], acceptance: [`${id} works`], check: `test ${id}`, dependsOn, kind, ...(estimateMin === undefined ? {} : { estimateMin }) })
const PLAN = {
  approach: 'do it in small pieces', rejected: 'one big agent: too slow', contracts: 'each ticket owns its own file', checks: 'make test',
  tickets: [ticket('T1', 'mechanical', [], 2), ticket('T2', 'routine', ['T1'], 3), ticket('T3', 'judgment', [], 6), ticket('T4', 'mechanical', ['T3']), ticket('T5', 'hard', ['T6'], 4), ticket('T6', 'routine', ['T5'], 4)],
}

const FIX_PLAN = {
  approach: 'fix the reported issues', rejected: '', contracts: 'each fix ticket owns its own file', checks: 'make test',
  tickets: [ticket('X1', 'routine', [], 3), ticket('X2', 'mechanical', ['X1', 'X1'], 2)],
}
const SHIP = { verdict: 'ship', summary: 'looks right', issues: [] }
const FIX_FIRST = { verdict: 'fix first', summary: 'two problems', issues: ['finished sprints still say time left (flight.tsx:263)', 'arrow keys overshoot the run (scrubber.tsx:40)'] }

async function scenario(argsIn, budget, plan = PLAN, opts = {}) {
  const calls = [], logs = [], reviews = {}, perPlace = new Map()
  const finals = [...(opts.finals ?? [SHIP])]
  const agent = async (prompt, o) => {
    const at = (slot.getStore() || []).join('.') || 'top'
    perPlace.set(at, (perPlace.get(at) || 0) + 1)
    calls.push({ label: o.label, model: o.model, effort: o.effort, phase: o.phase, prompt, place: `${at}#${perPlace.get(at)}` })
    budget.charge?.()
    await new Promise(r => setTimeout(r, opts.delay ? opts.delay() : 1))
    opts.before?.(o)
    const id = o.label.split(' ')[0]
    if (o.label.startsWith('fix plan')) return opts.fixPlan ?? FIX_PLAN
    if (o.label.startsWith('plan critic')) return { ...plan, changes: 'none' }
    if (o.label.startsWith('plan')) return plan
    if (o.label.includes(' build ')) return { summary: `${id} built`, changed: [`${id}.txt`], checkOutput: 'ok', notes: id === 'T1' ? 'T1 note for T2' : '', done: true }
    if (o.label.startsWith('final review') && opts.finalFor) return opts.finalFor(prompt, o)
    if (o.label.startsWith('final review')) return finals.length > 1 ? finals.shift() : finals[0]
    if (o.label.includes(' review ')) {
      reviews[id] = (reviews[id] || 0) + 1
      if (id === 'T3') return { pass: false, issues: ['T3 still wrong'], summary: 'no' }
      if (id === 'T2' && reviews[id] === 1) return { pass: false, issues: ['T2 missed a case'], summary: 'almost' }
      return { pass: true, issues: [], summary: 'good' }
    }
    if (o.label.startsWith('integrate')) return { summary: 'all wired', checks: [{ command: 'make test', passed: true, tail: 'ok' }], fixed: [], remaining: [] }
    throw new Error('unexpected agent ' + o.label)
  }
  const result = await run(agent, () => {}, m => logs.push(m), budget, argsIn, parallel)
  return { result, calls, logs }
}

const free = { total: null, spent: () => 0, remaining: () => Infinity }

// A: full run with a dependency cycle between T5 and T6
{
  const { result, calls, logs } = await scenario({ goal: 'test goal' }, free)
  const line = id => result.tickets.find(t => t.startsWith(id + ' '))
  assert.match(line('T1'), /^T1 passed \[haiku·low\]/)
  assert.match(line('T2'), /^T2 passed \[sonnet·medium → sonnet·high\]/)
  assert.match(line('T3'), /^T3 failed \[sonnet·high → top·high → top·max\].*open: T3 still wrong/)
  assert.match(line('T4'), /^T4 skipped \[not run\].*needs T3/)
  assert.match(line('T5'), /^T5 passed/)
  assert.match(line('T6'), /^T6 passed/)
  assert.ok(logs.some(l => l.includes('Dependency cycle among T5, T6')))
  const labels = calls.map(c => c.label)
  assert.ok(labels.includes('T1 review 1/3 (sonnet·high)'), 'review floor is sonnet·high')
  assert.ok(labels.includes('T2 review 2/3 (top·high)'), 'retry review climbs with the builder')
  assert.ok(labels.filter(l => l.startsWith('T3 review')).length === 3)
  assert.ok(labels.indexOf('T2 build 1/3 (sonnet·medium)') > labels.indexOf('T1 review 1/3 (sonnet·high)'), 'T2 waits for T1')
  assert.ok(labels.indexOf('T3 build 1/3 (sonnet·high)') < labels.indexOf('T1 review 1/3 (sonnet·high)'), 'T3 runs alongside T1')
  assert.ok(calls.find(c => c.label.startsWith('T2 build 1/3 (sonnet·medium)')).prompt.includes('T1 note for T2'), 'data passes forward')
  assert.ok(calls.find(c => c.label.startsWith('T2 build 2/3 (sonnet·high)')).prompt.includes('T2 missed a case'), 'review issues pass back')
  assert.ok(calls.every(c => typeof c.effort === 'string'), 'every agent names an effort')
  assert.deepEqual([...new Set(calls.filter(c => c.label.includes('haiku')).map(c => c.model))], ['haiku'])
  assert.ok(calls.filter(c => c.label.includes('top·')).every(c => c.model === undefined), 'top tier inherits the session model')
  assert.deepEqual(labels.filter(l => l.startsWith('T3 review')), ['T3 review 1/3 (top·high)', 'T3 review 2/3 (top·high)', 'T3 review 3/3 (top·high)'], 'review ceiling')
  assert.ok(!labels.some(l => / review \d\/\d \(top·max\)$/.test(l)), 'no ticket review at top·max')
  assert.ok(labels.includes('final review (top·max)'))
  assert.ok(line('T1').includes('~2m') && line('T4').includes('~3m'), 'estimates, with kind default')
  assert.ok(calls[0].prompt.includes('estimateMin') && calls[0].prompt.includes('about 250 words'))
  assert.ok(calls.find(c => c.label.startsWith('plan critic')).prompt.includes('dependency chains longer'))
  assert.ok(logs.some(l => l.startsWith('Draft:') && l.includes('longest chain T3 → T4')), 'draft chain log')
  assert.ok(logs.some(l => l.startsWith('Plan: 6 tickets, about') && l.includes('longest chain T3 → T4')), 'final chain log')
  assert.ok(calls.find(c => c.label.startsWith('plan critic')).prompt.includes('longest dependency chain is T3 → T4'), 'critic gets the chain')
  assert.ok(result.criticalPath.startsWith('T3 → T4'), 'criticalPath')
  assert.ok(calls.find(c => c.label.includes(' build 1/3')).label.startsWith('T3 '), 'longest chain starts first')
  assert.deepEqual(result.tickets.map(t => t.split(' ')[0]), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], 'results keep plan order')
  assert.equal(result.verdict, 'ship')
  assert.equal(calls.filter(c => c.label.startsWith('integrate')).length, 1)
  console.log('A ok:', result.tickets.length, 'tickets,', calls.length, 'agents')
}
// B: the ticket limit drops T6, so T5 (which needs it) is skipped
{
  const { result, logs } = await scenario({ goal: 'test goal', maxTickets: 5 }, free)
  assert.deepEqual(result.dropped, ['T6 ticket T6'])
  assert.match(result.tickets.find(t => t.startsWith('T5 ')), /skipped.*needs T6/)
  assert.ok(logs.some(l => l.includes('Over the 5-ticket limit')))
  console.log('B ok:', result.tickets.find(t => t.startsWith('T5 ')))
}
// C: a turn budget that runs out partway stops new work and says so
{
  let spent = 0
  const tight = { total: 300000, spent: () => spent, remaining: () => Math.max(0, 300000 - spent), charge: () => { spent += 45000 } }
  const { result, logs } = await scenario({ goal: 'test goal' }, tight)
assert.ok(result.tickets.some(t => /stopped( before review)?: hit the turn budget/.test(t)))
  assert.ok(logs.some(l => l.includes('hit the turn budget')))
  assert.equal(result.verdict, 'not reviewed')
  console.log('C ok:', result.tickets.filter(t => t.includes('stopped')).length, 'tickets stopped by the budget;', logs.filter(l => l.includes('skipped')).join(' | '))
}
// D: a plain string goal works, and an empty one is refused
{
  const { result } = await scenario('just a string goal', free)
  assert.equal(result.goal, 'just a string goal')
  await assert.rejects(() => scenario({}, free), /sprint needs a goal/)
  console.log('D ok')
}
// E: a ticket estimated over 10 minutes is named to the critic
{
  const big = { ...PLAN, tickets: [ticket('T1', 'routine', [], 15), ticket('T2', 'mechanical', ['T1'], 2)] }
  const { result, calls } = await scenario({ goal: 'test goal' }, free, big)
  const prompt = calls.find(c => c.label.startsWith('plan critic')).prompt
  assert.ok(prompt.includes('over 10 minutes') && prompt.includes('T1 (15 min)'))
  assert.ok(!prompt.includes('T2 (2 min)'))
  assert.ok(result.criticalPath.startsWith('T1 → T2 (about 17 of 17 min)'))
  console.log('E ok')
}
// F: a final review that says fix first gets one fix round: triage, F tickets, integration and a second final review
{
  const { result, calls, logs } = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [FIX_FIRST, SHIP] })
  const labels = calls.map(c => c.label)
  assert.equal(labels.filter(l => l === 'fix plan (top·high)').length, 1, 'one triage')
  const triage = calls.find(c => c.label === 'fix plan (top·high)')
  assert.ok(triage.prompt.includes('fix round 1') && triage.prompt.includes('flight.tsx:263') && triage.prompt.includes('scrubber.tsx:40'), 'the issues reach triage')
  assert.ok(labels.indexOf('fix plan (top·high)') > labels.indexOf('final review (top·max)'), 'triage comes after the first final review')
  assert.match(result.tickets.find(t => t.startsWith('F1 ')), /^F1 passed \[sonnet·medium\]/)
  assert.match(result.tickets.find(t => t.startsWith('F2 ')), /^F2 passed \[haiku·low\]/)
  assert.ok(labels.indexOf('F2 build 1/3 (haiku·low)') > labels.indexOf('F1 review 1/3 (sonnet·high)'), 'X2 → F2 still waits for X1 → F1')
  assert.ok(calls.find(c => c.label.startsWith('F1 build')).prompt.includes('This is fix round 1'), 'fix builders know the round')
  assert.equal(labels.filter(l => l.startsWith('integrate')).length, 2)
  assert.equal(labels.filter(l => l.startsWith('final review')).length, 2)
  assert.ok(calls.filter(c => c.label.startsWith('integrate'))[1].prompt.includes('F1 passed'), 'the second integration sees the fix tickets')
  assert.ok(logs.some(l => l.includes('starting fix round 1')))
  assert.ok(!logs.some(l => l.includes('Dependency cycle among F')), 'the duplicated X1 link is no cycle')
  assert.deepEqual(result.rounds, ['first round: 6 tickets, fix first', 'fix round 1: 2 tickets, ship'])
  assert.equal(result.verdict, 'ship')
  assert.deepEqual(result.openIssues, [])
  console.log('F ok:', result.rounds.join(' | '))
}
// G: issues mode goes straight to a triage agent, with no planner or critic
{
  const { result, calls } = await scenario({ goal: 'fix the reported bugs', issues: ['bug A in a.ts', 'bug B in b.ts'] }, free, PLAN)
  const labels = calls.map(c => c.label)
  assert.equal(labels[0], 'fix plan (top·high)')
  assert.ok(!labels.some(l => l.startsWith('plan')), 'no planner and no critic')
  assert.ok(calls[0].prompt.includes('bug A in a.ts') && calls[0].prompt.includes('bug B in b.ts') && !calls[0].prompt.includes('fix round'))
  assert.deepEqual(result.tickets.map(t => t.split(' ')[0]), ['F1', 'F2'])
  assert.equal(result.planChanges, 'triaged from known issues, no planner')
  assert.equal(result.verdict, 'ship')
  const asText = await scenario({ goal: 'fix', issues: 'one thing\n\n  another thing  ' }, free, PLAN)
  assert.ok(asText.calls[0].prompt.includes('- one thing\n- another thing'), 'issues as lines of text')
  console.log('G ok:', result.tickets.join(' | '))
}
// H: a ticket that names the same dependency twice still runs after it, with no false cycle
{
  const twice = { ...PLAN, tickets: [ticket('A1', 'mechanical', [], 2), ticket('A2', 'mechanical', ['A1', 'A1'], 2), ticket('A3', 'mechanical', ['A2'], 2)] }
  const { result, calls, logs } = await scenario({ goal: 'test goal' }, free, twice)
  const labels = calls.map(c => c.label)
  assert.ok(!logs.some(l => l.includes('Dependency cycle')), 'no cycle')
  assert.ok(labels.indexOf('A2 build 1/3 (haiku·low)') > labels.indexOf('A1 review 1/3 (sonnet·high)'))
  assert.ok(labels.indexOf('A3 build 1/3 (haiku·low)') > labels.indexOf('A2 review 1/3 (sonnet·high)'))
  assert.ok(result.tickets.every(t => / passed /.test(t)))
  console.log('H ok')
}
// I and J: fixRounds 0 turns the fix round off, and the round limit holds when the reviewer is never satisfied
{
  const off = await scenario({ goal: 'test goal', fixRounds: 0 }, free, PLAN, { finals: [FIX_FIRST] })
  assert.ok(!off.calls.some(c => c.label.startsWith('fix plan')))
  assert.equal(off.result.verdict, 'fix first')
  assert.deepEqual(off.result.openIssues, FIX_FIRST.issues)
  assert.ok(off.logs.some(l => l.includes('says fix first and no fix round ran')))
  assert.ok(!off.logs.some(l => l.includes('after 0 fix rounds')))
  const stubborn = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [FIX_FIRST, FIX_FIRST, FIX_FIRST] })
  assert.equal(stubborn.calls.filter(c => c.label.startsWith('fix plan')).length, 1)
  assert.equal(stubborn.calls.filter(c => c.label.startsWith('final review')).length, 2)
  assert.ok(stubborn.logs.some(l => l.includes('still says fix first after 1 fix round;')))
  const ids = stubborn.result.tickets.map(t => t.split(' ')[0])
  assert.equal(new Set(ids).size, ids.length, 'no id is reused')
  console.log('I ok, J ok')
}
// K: the cap counts what this sprint spends, not what the turn spent before it started
{
  let spent = 900000
  const busy = { total: null, spent: () => spent, remaining: () => Infinity, charge: () => { spent += 1000 } }
  const { result, calls } = await scenario({ goal: 'test goal', cap: 500000 }, busy)
  assert.ok(result.tickets.every(t => !t.includes('hit the')), 'no ticket hits the cap')
  assert.match(result.tickets.find(t => t.startsWith('T1 ')), /^T1 passed/)
  assert.equal(result.verdict, 'ship')
  assert.ok(calls.some(c => c.label.startsWith('final review')))
  let spent2 = 900000
  const over = { total: null, spent: () => spent2, remaining: () => Infinity, charge: () => { spent2 += 200000 } }
  const capped = await scenario({ goal: 'test goal', cap: 500000 }, over)
  assert.ok(capped.logs.some(l => l.includes('hit the 500000-token cap')), 'spending since the start still trips the cap')
  console.log('K ok')
}
// L: a throwing agent call stops only its lane, with the message, and the sprint still returns
{
  const { result, calls, logs } = await scenario({ goal: 'test goal' }, free, PLAN, {
    before: o => { if (o.label.startsWith('T1 review 1/3')) throw new Error('agent crashed: socket closed') },
  })
  const line = id => result.tickets.find(t => t.startsWith(id + ' '))
  assert.match(line('T1'), /^T1 stopped \[haiku·low\].*stopped: agent crashed: socket closed/)
  assert.match(line('T2'), /^T2 skipped \[not run\].*needs T1/)
  assert.match(line('T3'), /^T3 failed/)
  assert.match(line('T5'), /^T5 passed/)
  assert.match(line('T6'), /^T6 passed/)
  assert.ok(logs.includes('T1 stopped: agent crashed: socket closed'))
  assert.ok(!calls.some(c => c.label.startsWith('T2 ')), 'the dependent never runs')
  assert.equal(result.verdict, 'ship')
  assert.equal(result.tickets.length, 6)
  // a throw in the integration or the final review is logged and treated as no result
  const closing = await scenario({ goal: 'test goal' }, free, PLAN, {
    before: o => { if (o.label.startsWith('integrate')) throw new Error('integrate crashed') },
  })
  assert.ok(closing.logs.some(l => l.includes('integrate crashed')))
  assert.equal(closing.result.integration, 'not run')
  const lastly = await scenario({ goal: 'test goal' }, free, PLAN, {
    before: o => { if (o.label.startsWith('final review')) throw new Error('final crashed') },
  })
  assert.ok(lastly.logs.some(l => l.includes('final crashed')))
  assert.equal(lastly.result.verdict, 'not reviewed')
  console.log('L ok')
}
// M: the budget is spent right after a build, so no review follows it and the log says so
{
  let spent = 0
  const meter = { total: null, spent: () => spent, remaining: () => Infinity }
  const one = { ...PLAN, tickets: [ticket('T1', 'mechanical', [], 2)] }
  const { result, calls, logs } = await scenario({ goal: 'test goal', cap: 500000 }, meter, one, {
    before: o => { if (o.label.startsWith('T1 build 1/3')) spent += 600000 },
  })
  assert.ok(!calls.some(c => c.label.startsWith('T1 review')), 'no review call after the cap is hit')
  assert.ok(logs.includes('T1 stopped before review: hit the 500000-token cap'))
  assert.match(result.tickets[0], /^T1 skipped \[haiku·low\].*stopped before review: hit the 500000-token cap/)
  assert.equal(result.verdict, 'not reviewed')
  console.log('M ok')
}
// N: a fix round whose final review does not finish keeps the first verdict and its issues
{
  const { result, logs } = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [FIX_FIRST, null] })
  assert.equal(result.verdict, 'fix first')
  assert.deepEqual(result.openIssues, FIX_FIRST.issues)
  assert.equal(result.finalSummary, FIX_FIRST.summary)
  assert.deepEqual(result.rounds, ['first round: 6 tickets, fix first', 'fix round 1: 2 tickets, not reviewed'])
  assert.ok(logs.includes("Fix round 1's final review did not finish (the reviewer returned nothing); keeping the first round verdict and its 2 open issues."), 'the log explains why')
  // the same when the cap runs out before the second final review
  let spent = 0, integrations = 0
  const meter = { total: null, spent: () => spent, remaining: () => Infinity }
  const capped = await scenario({ goal: 'test goal', cap: 500000 }, meter, PLAN, {
    finals: [FIX_FIRST],
    before: o => { if (o.label.startsWith('integrate') && ++integrations === 2) spent += 600000 },
  })
  assert.equal(capped.result.verdict, 'fix first')
  assert.deepEqual(capped.result.openIssues, FIX_FIRST.issues)
  assert.ok(capped.logs.includes("Fix round 1's final review did not finish (hit the 500000-token cap); keeping the first round verdict and its 2 open issues."))
  console.log('N ok')
}
// O: a ticket that depends on a cycle member keeps that link; only the cycle's own links are dropped
{
  const around = { ...PLAN, tickets: [ticket('T5', 'routine', ['T6'], 3), ticket('T6', 'routine', ['T5'], 3), ticket('T7', 'mechanical', ['T5'], 2)] }
  const { result, calls, logs } = await scenario({ goal: 'test goal' }, free, around)
  const labels = calls.map(c => c.label)
  assert.equal(logs.filter(l => l.includes('Dependency cycle')).length, 1, 'one log per cycle')
  assert.ok(logs.includes('Dependency cycle among T5, T6: those links were dropped'))
  assert.ok(!logs.some(l => l.includes('Dependency cycle among T5, T6, T7')), 'T7 is not part of the cycle')
  const t7 = labels.findIndex(l => l.startsWith('T7 build'))
  assert.ok(t7 > labels.indexOf('T5 review 1/3 (sonnet·high)'), 'T7 starts after T5 passed review')
  assert.ok(labels.some(l => l.startsWith('T6 build')))
  assert.ok(result.tickets.every(t => / passed /.test(t)), 'T5, T6 and T7 all run')
  console.log('O ok')
}
// P: reviewers 3 runs three final reviews at once, each from its own angle, and merges them
{
  let started = 0, returned = 0, startedBeforeFirstReturn = 0
  const answers = [
    { verdict: 'fix first', summary: 'goal mostly met', issues: ['Shared problem in a.ts', 'only the goal angle saw this'] },
    { verdict: 'fix first', summary: 'edge cases', issues: ['  shared   PROBLEM in A.ts ', 'edge case crashes b.ts'] },
    { verdict: 'ship', summary: 'integrates fine', issues: ['slow path in c.ts', 'edge case crashes b.ts'] },
  ]
  const byAngle = list => async prompt => {
    started += 1
    await new Promise(r => setTimeout(r, 5))
    if (returned === 0) startedBeforeFirstReturn = started
    returned += 1
    return prompt.includes('Your angle: whether the goal') ? list[0] : prompt.includes('Your angle: correctness') ? list[1] : list[2]
  }
  const { result, calls } = await scenario({ goal: 'test goal', reviewers: 3 }, free, PLAN, { finalFor: byAngle(answers) })
  const finals = calls.filter(c => c.label.startsWith('final review'))
  assert.equal(finals.length, 6, 'three reviewers in each of two rounds')
  assert.ok(finals.every(c => c.label === 'final review (top·max)'), 'every label stays final review (top·max)')
  assert.equal(startedBeforeFirstReturn, 3, 'all three start before any returns')
  const first = finals.slice(0, 3).map(c => c.prompt)
  assert.equal(new Set(first).size, 3, 'each reviewer has its own prompt')
  assert.ok(first[0].includes('Your angle: whether the goal') && first[1].includes('Your angle: correctness') && first[2].includes('Your angle: integration'))
  const triage = calls.find(c => c.label === 'fix plan (top·high)')
  assert.ok(triage, 'the merged fix first verdict starts a fix round')
  const listed = triage.prompt.split('Issues:\n')[1].split('\n\n')[0].split('\n').map(l => l.replace(/^- /, ''))
  assert.deepEqual(listed, ['Shared problem in a.ts', 'slow path in c.ts', 'only the goal angle saw this', 'edge case crashes b.ts'], 'combined, deduplicated, interleaved')
  assert.equal(result.verdict, 'fix first')
  assert.equal(result.finalSummary, 'goal mostly met | edge cases | integrates fine')
  // the worst verdict wins, and its reviewer's issues come first
  const blocked = await scenario({ goal: 'test goal', reviewers: 2, fixRounds: 0 }, free, PLAN, {
    finalFor: byAngle([{ verdict: 'ship', summary: 'fine', issues: ['minor thing'] }, { verdict: 'block', summary: 'broken', issues: ['it crashes'] }, SHIP]),
  })
  assert.equal(blocked.result.verdict, 'block')
  assert.deepEqual(blocked.result.openIssues, ['it crashes', 'minor thing'])
  assert.equal(blocked.calls.filter(c => c.label.startsWith('final review')).length, 2)
  // a reviewer that returns nothing or throws is dropped; all of them failing gives no verdict
  let n = 0
  const partial = await scenario({ goal: 'test goal', reviewers: 3, fixRounds: 0 }, free, PLAN, {
    finalFor: async () => { n += 1; if (n === 1) throw new Error('one crashed'); return n === 2 ? null : FIX_FIRST },
  })
  assert.equal(partial.result.verdict, 'fix first')
  assert.deepEqual(partial.result.openIssues, FIX_FIRST.issues)
  assert.ok(partial.logs.some(l => l.includes('Final review failed: one crashed')))
  const none = await scenario({ goal: 'test goal', reviewers: 3, fixRounds: 0 }, free, PLAN, { finalFor: async () => null })
  assert.equal(none.result.verdict, 'not reviewed')
  console.log('P ok:', result.rounds.join(' | '))
}
// Q: the default is one final reviewer with the unchanged prompt, and reviewers clamp to 1..3
{
  const count = async a => (await scenario({ goal: 'test goal', ...a }, free)).calls.filter(c => c.label.startsWith('final review'))
  const one = await count({})
  assert.equal(one.length, 1)
  assert.ok(!one[0].prompt.includes('Your angle'), 'a single reviewer gets no angle')
  assert.equal((await count({ reviewers: 9 })).length, 3)
  assert.equal((await count({ reviewers: 2 })).length, 2)
  assert.equal((await count({ reviewers: 0 })).length, 1)
  assert.equal((await count({ reviewers: -4 })).length, 1)
  assert.equal((await count({ reviewers: 'x' })).length, 1)
  assert.equal((await count({ reviewers: 2.9 })).length, 2)
  assert.ok(fs.readFileSync(process.argv[2], 'utf8').includes('reviewers? (1-3, default 1'), 'whenToUse documents reviewers')
  console.log('Q ok')
}
// R: a critic that throws does not throw the sprint; the draft runs
{
  const { result, logs } = await scenario({ goal: 'test goal' }, free, PLAN, { before: o => { if (o.label.startsWith('plan critic')) throw new Error('Blocked by a spawn guard') } })
  assert.equal(result.tickets.length, 6, 'the draft tickets run')
  assert.ok(logs.some(l => l.includes('The plan critic failed (Blocked by a spawn guard), so the draft runs as is.')))
  assert.ok(!logs.some(l => l.includes('The critic returned nothing')))
  console.log('R ok')
}
// S: a triage call that throws ends the fix loop with round 0's results
{
  const { result, logs, calls } = await scenario({ goal: 'test goal' }, free, PLAN, {
    finals: [FIX_FIRST],
    before: o => { if (o.label.startsWith('fix plan')) throw new Error('turn budget of 1000000 tokens is spent') },
  })
  assert.equal(result.verdict, 'fix first')
  assert.deepEqual(result.openIssues, FIX_FIRST.issues)
  assert.equal(result.tickets.length, 6)
  assert.equal(result.rounds.length, 1)
  assert.equal(calls.filter(c => c.label.startsWith('fix plan')).length, 1)
  assert.ok(logs.some(l => l.includes('Fix round 1 has no plan: the triage agent failed (turn budget of 1000000 tokens is spent).')))
  assert.ok(logs.some(l => l.includes('says fix first and no fix round ran')), 'a failed triage is not counted as a fix round')
  assert.ok(!logs.some(l => l.includes('after 1 fix round')))
  console.log('S ok')
}
// T: resume-safe. A resumed run is replayed by each agent call's place in its chain (the top level or one
// parallel() slot), so every call must land in the same place whatever order the agents finish in.
{
  const seeded = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const placed = async seed => {
    const rand = seeded(seed)
    const { calls } = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [FIX_FIRST, SHIP], delay: () => Math.floor(rand() * 12) })
    return calls.map(c => `${c.place} ${c.label} ${c.prompt.length}`).sort()
  }
  const first = await placed(1)
  for (const seed of [2, 3, 4, 5]) assert.deepEqual(await placed(seed), first, `with finishing order ${seed} an agent call lands somewhere else, so a resume would rerun finished work`)
  console.log('T ok:', first.length, 'calls land in the same places across 5 finishing orders')
}
// U: builders and reviewers are told to put a bug back only in a copy of the project
{
  const { calls } = await scenario({ goal: 'test goal', reviewers: 2 }, free, PLAN, { finals: [SHIP] })
  const asked = calls.filter(c => / (build|review) \d\/3 /.test(c.label) || c.label.startsWith('final review'))
  assert.ok(asked.some(c => c.label.startsWith('final review')) && asked.some(c => c.label.includes(' build ')))
  for (const c of asked) assert.ok(c.prompt.includes('in a copy of the project in your own scratch folder, never in the project itself'), `${c.label} is not told to use a copy`)
  console.log('U ok:', asked.length, 'build and review prompts carry the copy rule')
}
// V: only blocking problems start a fix round; polish is reported, and a fix first with nothing blocking counts as ship
{
  const POLISHED = { verdict: 'ship', summary: 'good', issues: [], polish: ['the button row wraps at 80 columns'] }
  const shipped = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [POLISHED] })
  assert.equal(shipped.result.verdict, 'ship')
  assert.deepEqual(shipped.result.polish, POLISHED.polish)
  assert.ok(!shipped.calls.some(c => c.label.startsWith('fix plan')))
  assert.ok(shipped.calls.filter(c => c.label.startsWith('final review')).every(c => c.prompt.includes('Only blocking problems go in issues and start a fix round')))
  const nits = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [{ verdict: 'fix first', summary: 'nits', issues: [], polish: ['a nit'] }] })
  assert.equal(nits.result.verdict, 'ship')
  assert.ok(!nits.calls.some(c => c.label.startsWith('fix plan')))
  assert.ok(nits.logs.some(l => l.includes('listed nothing blocking (1 polish), so it counts as ship')))
  const two = await scenario({ goal: 'test goal', reviewers: 2 }, free, PLAN, {
    finals: [{ verdict: 'fix first', summary: 'a', issues: ['crash in a.ts'], polish: ['nit one', 'Shared nit'] }, { verdict: 'ship', summary: 'b', issues: [], polish: ['shared  nit', 'Crash in a.ts'] }, SHIP],
  })
  assert.equal(two.calls.filter(c => c.label.startsWith('fix plan')).length, 1, 'a blocking problem from either reviewer starts a fix round')
  assert.equal(two.result.verdict, 'ship')
  const before = await scenario({ goal: 'test goal', reviewers: 2, fixRounds: 0 }, free, PLAN, {
    finals: [{ verdict: 'fix first', summary: 'a', issues: ['crash in a.ts'], polish: ['nit one', 'Shared nit'] }, { verdict: 'ship', summary: 'b', issues: [], polish: ['shared  nit', 'Crash in a.ts'] }],
  })
  assert.deepEqual(before.result.openIssues, ['crash in a.ts'])
  assert.deepEqual(before.result.polish, ['nit one', 'shared  nit'], 'polish is merged round-robin without repeats, and polish that repeats a blocking issue is dropped')
  const old = await scenario({ goal: 'test goal' }, free, PLAN, { finals: [SHIP] })
  assert.deepEqual(old.result.polish, [], 'a verdict without polish reports an empty list')
  console.log('V ok')
}

