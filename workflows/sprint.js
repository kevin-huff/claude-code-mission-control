export const meta = {
  name: 'sprint',
  description: 'Run build or change work like a sprint: a decision layer plans small tickets, fast agents build them, stronger agents review each one, failures retry one tier up in their own lane, and a final review that says fix first gets a fix round',
  whenToUse: 'Multi-part build, fix or change work that splits into pieces. args: {goal, context?, checks?, maxTickets?, cap?, issues?, fixRounds?, reviewers?}, or the goal as a plain string. Pass issues (a list of already-diagnosed problems) to skip the planner and go straight to fix tickets. reviewers? (1-3, default 1: 3 runs three parallel final reviewers from different angles, finding more at more wall-clock time).',
  phases: [
    { title: 'Decide', detail: 'a top-tier planner settles the approach, pins the contracts and cuts small tickets; a critic tightens the plan (known issues go to a faster triage instead)' },
    { title: 'Build', detail: 'one small agent per ticket, starting low and fast' },
    { title: 'Review', detail: 'an agent a tier above the builder (sonnet·high to top·high) checks each ticket against its acceptance criteria' },
    { title: 'Integrate', detail: 'run every check across the whole change and fix the seams' },
    { title: 'Final review', detail: 'top-tier adversarial review of the whole change (reviewers 2 or 3 run that many in parallel, each from its own angle, and their findings are merged); only blocking problems start a fix round, polish is reported' },
  ],
}

// The tier ladder. A null model leaves the session's own (top) model in place.
const RUNGS = [
  { tier: 'haiku·low', model: 'haiku', effort: 'low' },
  { tier: 'sonnet·medium', model: 'sonnet', effort: 'medium' },
  { tier: 'sonnet·high', model: 'sonnet', effort: 'high' },
  { tier: 'top·high', model: null, effort: 'high' },
  { tier: 'top·max', model: null, effort: 'max' },
]
const START_RUNG = { mechanical: 0, routine: 1, judgment: 2, hard: 3 }
const KIND_MINUTES = { mechanical: 3, routine: 4, judgment: 6, hard: 9 }
const REVIEW_FLOOR = 2
const TOP_HIGH = 3
const TOP_MAX = 4
const REVIEW_CEIL = TOP_HIGH
const MAX_RETRIES = 2
const AGENT_FLOOR = 40000

// Longest dependency chains. Items are { id, dependsOn, estimateMin }. Links to unknown ids, to the item
// itself, and back into a chain being walked (a cycle) count as absent, so inside a cycle the values
// depend on list order.
function chainOf(list) {
  const byId = new Map()
  for (const t of list) if (!byId.has(t.id)) byId.set(t.id, t)
  const dependents = new Map(list.map(t => [t.id, []]))
  for (const t of list) {
    for (const d of new Set(t.dependsOn)) {
      if (d !== t.id && byId.has(d) && !dependents.get(d).includes(t.id)) dependents.get(d).push(t.id)
    }
  }
  const down = new Map()
  const visiting = new Set()
  function walk(id) {
    if (down.has(id)) return down.get(id)
    visiting.add(id)
    let best = 0
    for (const d of dependents.get(id)) {
      if (visiting.has(d)) continue
      best = Math.max(best, walk(d))
    }
    visiting.delete(id)
    down.set(id, byId.get(id).estimateMin + best)
    return down.get(id)
  }
  for (const t of list) walk(t.id)
  const total = list.reduce((sum, t) => sum + t.estimateMin, 0)
  let start = null
  for (const t of list) if (start === null || down.get(t.id) > down.get(start)) start = t.id
  const path = []
  const seen = new Set()
  let at = start
  while (at !== null && !seen.has(at)) {
    seen.add(at)
    path.push(at)
    let next = null
    for (const d of dependents.get(at)) {
      if (seen.has(d)) continue
      if (next === null || down.get(d) > down.get(next)) next = d
    }
    at = next
  }
  return { total, minutes: start === null ? 0 : down.get(start), path, down }
}

function tierOpts(rung, label, phaseName, schema) {
  const r = RUNGS[rung]
  const o = { label: `${label} (${r.tier})`, phase: phaseName, schema, effort: r.effort }
  if (r.model) o.model = r.model
  return o
}

const input = typeof args === 'string' ? { goal: args } : args || {}
const goal = String(input.goal || '').trim()
if (!goal) throw new Error('sprint needs a goal: Workflow({ name: "sprint", args: { goal: "..." } })')
const context = String(input.context || '').trim()
const extraChecks = String(input.checks || '').trim()
const maxTickets = Math.max(1, Math.min(40, Number(input.maxTickets) || 16))
const cap = Number(input.cap) || 0
const givenIssues = (Array.isArray(input.issues) ? input.issues : String(input.issues || '').split('\n'))
  .map(s => String(s).trim())
  .filter(Boolean)
const fixRounds = Math.max(0, Math.min(3, input.fixRounds === undefined ? 1 : Math.floor(Number(input.fixRounds) || 0)))
const reviewers = Math.max(1, Math.min(3, Math.floor(Number(input.reviewers) || 1)))

const spentAtStart = budget.spent()

function overCap() {
  if (budget.total && budget.remaining() < AGENT_FLOOR) return 'the turn budget'
  if (cap && budget.spent() - spentAtStart > cap) return `the ${cap}-token cap`
  return ''
}

const TICKET = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short unique id such as T1' },
    title: { type: 'string', description: 'A few words' },
    task: { type: 'string', description: 'Exactly what to do, self-contained: an agent with no other context must be able to do it from this, the approach and the contracts alone' },
    files: { type: 'array', items: { type: 'string' }, description: 'Every file this ticket creates or changes' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable conditions for done' },
    check: { type: 'string', description: 'A command that shows this ticket works, or an empty string if none fits' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of tickets that must pass first' },
    kind: {
      type: 'string',
      enum: ['mechanical', 'routine', 'judgment', 'hard'],
      description: 'mechanical: a clear recipe; routine: light judgment; judgment: real engineering calls; hard: novel, risky or numerically delicate',
    },
    estimateMin: { type: 'number', description: 'Minutes this ticket should take from start to passing review at its starting tier, build plus review. Most tickets take 2 to 8.' },
  },
  required: ['id', 'title', 'task', 'files', 'acceptance', 'check', 'dependsOn', 'kind', 'estimateMin'],
}
const PLAN = {
  type: 'object',
  properties: {
    approach: { type: 'string', description: 'The decision: how the goal gets done and why this way, at most eight sentences' },
    rejected: { type: 'string', description: 'Approaches considered and dropped, one line each with the reason' },
    contracts: { type: 'string', description: 'What every ticket must agree on: interfaces, names, data formats, and which ticket owns which file' },
    checks: { type: 'string', description: 'Commands that prove the whole change works (tests, build, lint), one per line; empty if none exist' },
    tickets: { type: 'array', items: TICKET, minItems: 1 },
  },
  required: ['approach', 'rejected', 'contracts', 'checks', 'tickets'],
}
const CRITIQUED = {
  ...PLAN,
  properties: { ...PLAN.properties, changes: { type: 'string', description: 'What you changed in the plan and why, one line each; "none" if it stands' } },
  required: [...PLAN.required, 'changes'],
}
const BUILT = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One line: what you did' },
    changed: { type: 'array', items: { type: 'string' }, description: 'Files created or changed' },
    checkOutput: { type: 'string', description: 'The last lines of the check output, or why it could not run' },
    notes: { type: 'string', description: 'What a later ticket or the reviewer must know, at most three lines; empty if nothing' },
    done: { type: 'boolean', description: 'True only if every acceptance condition holds' },
  },
  required: ['summary', 'changed', 'checkOutput', 'notes', 'done'],
}
const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' }, description: 'Blocking problems only, each specific enough for a builder to fix' },
    summary: { type: 'string', description: 'One line verdict' },
  },
  required: ['pass', 'issues', 'summary'],
}
const INTEGRATED = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One line' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, passed: { type: 'boolean' }, tail: { type: 'string', description: 'The last few lines of output' } },
        required: ['command', 'passed', 'tail'],
      },
    },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'checks', 'fixed', 'remaining'],
}
const FINAL = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix first', 'block'], description: 'ship when nothing blocks, even with polish left; fix first when a blocking problem can be fixed in this sprint; block when the approach itself is wrong' },
    summary: { type: 'string', description: 'One line' },
    issues: { type: 'array', items: { type: 'string' }, description: 'Blocking problems only, most serious first; empty when the verdict is ship' },
    polish: { type: 'array', items: { type: 'string' }, description: 'Worth fixing but not blocking; these never start a fix round' },
  },
  required: ['verdict', 'summary', 'issues', 'polish'],
}

const FINAL_ANGLES = [
  'whether the goal and every ticket\'s acceptance conditions are really met.',
  'correctness and edge cases: try to break it.',
  'integration, safety, performance and regressions.',
]
const VERDICT_RANK = { block: 0, 'fix first': 1, ship: 2 }

// One FINAL-shaped verdict from several reviewers: the worst verdict wins, summaries are joined, and the
// issues are interleaved round-robin from the worst reviewer down, without repeats.
function mergeFinals(list) {
  const got = list.filter(f => f && typeof f === 'object')
  if (!got.length) return null
  const rank = f => (f.verdict in VERDICT_RANK ? VERDICT_RANK[f.verdict] : VERDICT_RANK.block)
  const ordered = got.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(x => x.f)
  const seen = new Set()
  const issues = interleave(ordered.map(f => (Array.isArray(f.issues) ? f.issues : [])), seen)
  const polish = interleave(ordered.map(f => (Array.isArray(f.polish) ? f.polish : [])), seen)
  return {
    verdict: ordered[0].verdict,
    summary: ordered.map(f => String(f.summary || '').trim()).filter(Boolean).join(' | '),
    issues,
    polish,
  }
}

// Items from several lists, round-robin, without repeats (case and spacing ignored); seen carries over
// between calls, so polish that repeats a blocking issue is dropped.
function interleave(lists, seen) {
  const out = []
  for (let n = 0; lists.some(l => n < l.length); n++) {
    for (const l of lists) {
      if (n >= l.length) continue
      const text = String(l[n]).trim()
      const key = text.toLowerCase().replace(/\s+/g, ' ')
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(text)
    }
  }
  return out
}

// A verdict as the fix loop reads it: both lists always present, and a fix first with nothing blocking
// counts as ship.
function settle(f) {
  const out = { ...f, issues: Array.isArray(f.issues) ? f.issues : [], polish: Array.isArray(f.polish) ? f.polish : [] }
  if (out.verdict === 'fix first' && !out.issues.length) {
    log(`The final review said fix first but listed nothing blocking${out.polish.length ? ` (${out.polish.length} polish)` : ''}, so it counts as ship.`)
    out.verdict = 'ship'
  }
  return out
}

const PLAN_RULES = `How to cut tickets:
- Each ticket is one focused change a fast agent can finish in a few minutes, touching at most three files.
- Do not go smaller than that: every agent starts with about 40,000 tokens of context and several seconds of setup, so merge chores that would take under a minute.
- Tickets that could run at the same time never share a file; if two must touch one file, make one depend on the other.
- Mark each ticket's kind honestly. Mechanical and routine tickets go to fast small models, so write their task text so they cannot go wrong; anything delicate is judgment or hard.
- Every ticket needs checkable acceptance conditions and, where one fits, a command that shows it works. Aim that check at the ticket's own files (its own test file, a filtered run): other tickets are half-built while it runs, and the whole-project checks run at integration.
- Use dependsOn only where one ticket truly needs another's output.
- Give each ticket estimateMin: the minutes a fast agent needs to build it and get it through review. Most take 2 to 8; a ticket that needs more than 10 is too big, so split it.
- Keep each task under about 250 words: name the files, the functions and the exact change, and do not paste code the builder can read itself.
- The sprint cannot finish sooner than its longest chain of dependencies, so keep chains short: let tickets run side by side wherever they can, and where tickets only need to agree on a name or a format, write it into the contracts instead of chaining them.
- At most ${maxTickets} tickets.`

const SIDE_BY_SIDE =
  'Other tickets are being built at the same time, so a whole-project check can fail in files another ticket owns. Such failures are not this ticket\'s unless its change caused them: name those files in notes and make sure nothing in this ticket\'s own files fails.'

const BLOCKING_RULE =
  'Sort what you find. Blocking: wrong results, crashes or hangs, lost data, failing checks, broken contracts, a goal not met, or a defect users hit in normal use. Polish: everything else, such as rare edge cases, cosmetic or layout nits, wording and tidiness. Only blocking problems go in issues and start a fix round; say ship when nothing blocks, and list the rest as polish.'

const COPY_RULE =
  'If you put a bug back to check that a test catches it, do it in a copy of the project in your own scratch folder, never in the project itself: other agents run checks against these files at the same time.'

// Already-diagnosed issues go straight to tickets: one top-tier agent at high effort, no planner.
function triagePrompt(issues, round) {
  return [
    round
      ? `You plan fix round ${round} of a sprint. The sprint's final review found the issues below. Each one is already diagnosed and located: turn them into fix tickets and do not re-plan the project or add features.`
      : 'You plan a fix sprint. The issues below are already diagnosed and located: turn them into fix tickets and do not re-plan the project or add features.',
    `Goal: ${goal}`,
    context ? `Context: ${context}` : '',
    `Issues:\n- ${issues.join('\n- ')}`,
    'Put issues that touch the same file in one ticket, or chain the tickets, so no two tickets that can run at the same time share a file. Each task names the file, the line or function and the fix, and its acceptance includes the regression test the issue calls for. Leave out an issue only if it is wrong or already fixed, and say which and why in rejected.',
    PLAN_RULES,
    'Read only what you need to cut the tickets. Do not change any files. Return the plan.',
  ].filter(Boolean).join('\n\n')
}

// Ids, files, acceptance, deduplicated dependencies and estimates for one round's tickets. A prefix
// renames ids (F1, F2, ...) so fix tickets never collide with earlier ones.
function normalizeTickets(list, prefix, used) {
  const rename = new Map()
  let out = []
  for (const t of Array.isArray(list) ? list : []) {
    const asked = String(t.id || '').trim()
    let id
    if (prefix) {
      let n = 1
      while (used.has(`${prefix}${n}`)) n += 1
      id = `${prefix}${n}`
    } else {
      id = asked || `T${out.length + 1}`
      while (used.has(id)) id = `${id}'`
    }
    used.add(id)
    if (asked && !rename.has(asked)) rename.set(asked, id)
    const kind = START_RUNG[t.kind] === undefined ? 'judgment' : t.kind
    out.push({
      ...t,
      id,
      files: Array.isArray(t.files) ? t.files : [],
      acceptance: Array.isArray(t.acceptance) && t.acceptance.length ? t.acceptance : ['The task is done as described'],
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      kind,
      estimateMin: Number(t.estimateMin) > 0 ? Math.min(60, Number(t.estimateMin)) : KIND_MINUTES[kind],
    })
  }
  for (const t of out) t.dependsOn = [...new Set(t.dependsOn.map(d => rename.get(d) ?? d))]
  const dropped = out.slice(maxTickets).map(t => `${t.id} ${t.title}`)
  out = out.slice(0, maxTickets)
  if (dropped.length) log(`Over the ${maxTickets}-ticket limit, not run: ${dropped.join('; ')}`)
  const kept = new Set(out.map(t => t.id))
  const droppedIds = new Set(dropped.map(d => d.split(' ')[0]))
  for (const t of out) t.dependsOn = t.dependsOn.filter(d => d !== t.id && (kept.has(d) || droppedIds.has(d)))

  // Strongly connected components (Tarjan) over the kept links. Only links between two tickets of the
  // same component of size > 1 are dropped; a ticket that depends on a cycle member keeps its link.
  const byId = new Map(out.map(t => [t.id, t]))
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const component = new Map()
  const components = []
  let counter = 0
  function visit(id) {
    index.set(id, counter)
    low.set(id, counter)
    counter += 1
    stack.push(id)
    onStack.add(id)
    for (const d of byId.get(id).dependsOn) {
      if (!byId.has(d)) continue
      if (!index.has(d)) {
        visit(d)
        low.set(id, Math.min(low.get(id), low.get(d)))
      } else if (onStack.has(d)) {
        low.set(id, Math.min(low.get(id), index.get(d)))
      }
    }
    if (low.get(id) === index.get(id)) {
      const members = []
      let top
      do {
        top = stack.pop()
        onStack.delete(top)
        component.set(top, components.length)
        members.push(top)
      } while (top !== id)
      components.push(members)
    }
  }
  for (const t of out) if (!index.has(t.id)) visit(t.id)
  for (const members of components) {
    if (members.length < 2) continue
    const inPlanOrder = out.filter(t => members.includes(t.id)).map(t => t.id)
    log(`Dependency cycle among ${inPlanOrder.join(', ')}: those links were dropped`)
  }
  for (const t of out) t.dependsOn = t.dependsOn.filter(d => !(byId.has(d) && component.get(d) === component.get(t.id) && components[component.get(d)].length > 1))
  return { tickets: out, dropped }
}

function briefOf(plan, round) {
  return [
    `Sprint goal: ${goal}`,
    context ? `Context: ${context}` : '',
    `Approach (decided up front; do not relitigate it): ${plan.approach}`,
    `Contracts every ticket keeps: ${plan.contracts}`,
    round ? `This is fix round ${round}: every ticket fixes an issue the final review found.` : '',
  ].filter(Boolean).join('\n\n')
}

function buildPrompt(brief, t, handoff, issues, attempt) {
  return [
    'You are building one ticket of a sprint. Do this ticket and nothing else.',
    brief,
    `Ticket ${t.id}: ${t.title}\n${t.task}`,
    `Files you own: ${t.files.join(', ') || '(none listed)'}. Change only these. If the ticket truly needs another file, change it only if no other ticket owns it, and say so in notes.`,
    `Done means:\n- ${t.acceptance.join('\n- ')}`,
    t.check ? `Run this check before you finish: ${t.check}` : 'No check command was set; verify the acceptance conditions yourself.',
    SIDE_BY_SIDE,
    COPY_RULE,
    handoff ? `What the tickets you depend on did:\n${handoff}` : '',
    attempt ? `This is attempt ${attempt + 1}. The reviewer rejected the last attempt for:\n- ${issues.join('\n- ')}\nFix exactly these, starting from the files as they are now.` : '',
    'Report in one line plus the structured fields. Do not paste file contents back.',
  ].filter(Boolean).join('\n\n')
}

function reviewPrompt(brief, t, built) {
  return [
    'You review one ticket of a sprint. Do not change any files: read the changed files, run the check yourself, and judge.',
    brief,
    `Ticket ${t.id}: ${t.title}\n${t.task}`,
    `Done means:\n- ${t.acceptance.join('\n- ')}`,
    t.check ? `Check command: ${t.check}` : '',
    `The builder reports: ${built.summary}\nChanged: ${(built.changed || []).join(', ') || '(nothing listed)'}\nCheck output: ${built.checkOutput}\nNotes: ${built.notes || '(none)'}`,
    SIDE_BY_SIDE,
    COPY_RULE,
    'Pass it if every acceptance condition holds and the contracts are kept. List only blocking issues, each specific enough for a builder to fix; style nits are not blocking.',
  ].filter(Boolean).join('\n\n')
}

// Every ticket of one round in its own lane: build, review, and up to two retries one tier up. A lane
// waits for its dependencies and is skipped when one did not pass; the longest chains start first. Each lane
// runs in its own parallel() slot, so a resumed run replays it from the journal whatever order the agents
// finished in; longest-chain-first order also starts every dependency before the lanes that wait on it.
async function runRound(tickets, brief) {
  const byId = new Map(tickets.map(t => [t.id, t]))
  const chain = chainOf(tickets)
  const lanes = new Map()
  function runLane(t) {
    if (!lanes.has(t.id)) lanes.set(t.id, lane(t))
    return lanes.get(t.id)
  }
  async function lane(t) {
    const deps = await Promise.all(
      t.dependsOn.map(d => (byId.has(d) ? runLane(byId.get(d)) : Promise.resolve({ id: d, title: d, status: 'skipped', summary: 'dropped by the ticket limit', notes: '' }))),
    )
    const result = { id: t.id, title: t.title, kind: t.kind, estimateMin: t.estimateMin, status: 'skipped', tiers: [], attempts: 0, summary: '', changed: [], notes: '', issues: [] }
    const blockers = deps.filter(r => r.status !== 'passed')
    if (blockers.length) {
      result.summary = `skipped: needs ${blockers.map(r => r.id).join(', ')}, which did not pass`
      log(`${t.id} ${result.summary}`)
      return result
    }
    const handoff = deps.map(r => `${r.id} (${r.title}): ${r.summary}${r.notes ? `\nNotes: ${r.notes}` : ''}`).join('\n')
    let rung = START_RUNG[t.kind]
    let issues = []
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const capped = overCap()
        if (capped) {
          result.summary = `stopped: hit ${capped}`
          log(`${t.id} not built: hit ${capped}`)
          return result
        }
        result.attempts = attempt + 1
        result.tiers.push(RUNGS[rung].tier)
        const built = await agent(buildPrompt(brief, t, handoff, issues, attempt), tierOpts(rung, `${t.id} build ${attempt + 1}/${MAX_RETRIES + 1}`, 'Build', BUILT))
        if (!built) {
          issues = ['The last builder returned nothing; do the whole ticket.']
          result.issues = issues
          rung = Math.min(rung + 1, TOP_MAX)
          continue
        }
        result.summary = built.summary
        result.changed = built.changed || []
        result.notes = built.notes || ''
        const cappedBeforeReview = overCap()
        if (cappedBeforeReview) {
          result.summary = `stopped before review: hit ${cappedBeforeReview}`
          log(`${t.id} ${result.summary}`)
          return result
        }
        const reviewRung = Math.min(REVIEW_CEIL, Math.max(REVIEW_FLOOR, rung + 1))
        const verdict = await agent(reviewPrompt(brief, t, built), tierOpts(reviewRung, `${t.id} review ${attempt + 1}/${MAX_RETRIES + 1}`, 'Review', VERDICT))
        if (verdict && verdict.pass) {
          result.status = 'passed'
          result.issues = []
          return result
        }
        issues = verdict && verdict.issues.length ? verdict.issues : ['The reviewer gave no verdict; check the work against every acceptance condition.']
        result.issues = issues
        rung = Math.min(rung + 1, TOP_MAX)
        if (attempt < MAX_RETRIES) log(`${t.id} failed review (${verdict ? verdict.summary : 'no verdict'}); retrying at ${RUNGS[rung].tier}`)
      }
      result.status = 'failed'
      log(`${t.id} failed after ${result.attempts} attempts: ${result.issues.join('; ')}`)
      return result
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      result.status = 'stopped'
      result.summary = `stopped: ${message}`
      log(`${t.id} stopped: ${message}`)
      return result
    }
  }
  const order = [...tickets].sort((a, b) => chain.down.get(b.id) - chain.down.get(a.id))
  const done = await parallel(order.map(t => () => runLane(t)))
  return tickets.map(t => done[order.indexOf(t)] || { id: t.id, title: t.title, kind: t.kind, estimateMin: t.estimateMin, status: 'stopped', tiers: [], attempts: 0, summary: 'stopped: its lane failed', changed: [], notes: '', issues: [] })
}

// Integration over every ticket so far, then the top-tier final review.
async function closeOut(results, plan, brief) {
  const passed = results.filter(r => r.status === 'passed')
  if (!passed.length) {
    log('No ticket passed review, so integration and the final review were skipped.')
    return { integration: null, final: null }
  }
  if (overCap()) {
    log(`Integration and the final review were skipped: hit ${overCap()}.`)
    return { integration: null, final: null }
  }
  const ledger = results.map(r => `${r.id} ${r.status}: ${r.summary}`).join('\n')
  let integration = null
  try {
    integration = await agent(
      [
        'You integrate a sprint: the tickets below were built and reviewed one at a time. Run every check across the whole change, fix the seams between tickets (imports, names, wiring, formats), and report.',
        brief,
        `Checks to run:\n${[plan.checks, extraChecks].filter(Boolean).join('\n') || "(none given: find and run the project's own tests or build)"}`,
        `Tickets:\n${ledger}`,
        'Fix only what the checks or the contracts require. Report in one line plus the structured fields.',
      ].join('\n\n'),
      tierOpts(TOP_HIGH, 'integrate', 'Integrate', INTEGRATED),
    )
  } catch (e) {
    log(`Integration failed: ${e && e.message ? e.message : String(e)}`)
  }
  if (overCap()) return { integration, final: null }
  const finalPrompt = angle =>
    [
      'You are the final reviewer of a sprint. Try to find what is wrong with the whole change before it ships: whether the goal is really met, acceptance conditions across tickets, broken contracts, stray or missing changes, and failing checks. Run the checks yourself. Do not change any files.',
      BLOCKING_RULE,
      COPY_RULE,
      angle ? `Your angle: ${angle} Other reviewers are covering the other angles at the same time, so go deep on yours.` : '',
      brief,
      `Tickets:\n${ledger}`,
      integration ? `Integration: ${integration.summary}\nStill open after integration: ${integration.remaining.join('; ') || 'nothing'}` : 'Integration returned nothing.',
    ].filter(Boolean).join('\n\n')
  const askFinal = async angle => {
    try {
      return await agent(finalPrompt(angle), tierOpts(TOP_MAX, 'final review', 'Final review', FINAL))
    } catch (e) {
      log(`Final review failed: ${e && e.message ? e.message : String(e)}`)
      return null
    }
  }
  const final = reviewers === 1 ? await askFinal('') : mergeFinals(await Promise.all(FINAL_ANGLES.slice(0, reviewers).map(askFinal)))
  return { integration, final: final ? settle(final) : null }
}

const used = new Set()
let plan
let critiqued = null
let criticError = null
phase('Decide')
if (givenIssues.length) {
  plan = await agent(triagePrompt(givenIssues, 0), tierOpts(TOP_HIGH, 'fix plan', 'Decide', PLAN))
  if (!plan) throw new Error('The triage agent returned nothing, so there is no plan to run.')
  log(`Fix plan from ${givenIssues.length} known issues: ${Array.isArray(plan.tickets) ? plan.tickets.length : 0} tickets.`)
} else {
  const draft = await agent(
    [
      'You are the decision layer of a sprint. Explore the code and anything else you need, decide how the work gets done, and plan it as tickets.',
      `Goal: ${goal}`,
      context ? `Context: ${context}` : '',
      extraChecks ? `Checks the user wants run: ${extraChecks}` : '',
      'Read only what you need to cut the tickets and pin the contracts. Builders read the code themselves, so a task names files, functions and the exact change rather than quoting code.',
      PLAN_RULES,
      'Do not change any files. Return the plan.',
    ].filter(Boolean).join('\n\n'),
    tierOpts(TOP_MAX, 'plan', 'Decide', PLAN),
  )
  if (!draft) throw new Error('The planner returned nothing, so there is no plan to run.')
  const draftList = (Array.isArray(draft.tickets) ? draft.tickets : []).map(t => ({
    id: String(t.id).trim(),
    dependsOn: Array.isArray(t.dependsOn) ? [...new Set(t.dependsOn.map(String))] : [],
    estimateMin: Number(t.estimateMin) > 0 ? Number(t.estimateMin) : KIND_MINUTES[t.kind] || 6,
  }))
  const draftChain = chainOf(draftList)
  log(`Draft: ${draftList.length} tickets, about ${draftChain.total} agent-minutes; longest chain ${draftChain.path.join(' → ')}, about ${draftChain.minutes} min.`)
  const draftLong = draftList.filter(t => t.estimateMin > 10)
  try {
    critiqued = await agent(
      [
        'You review a sprint plan before anything is built. Check it against the code and the goal, then return the plan as it should be run.',
        `Goal: ${goal}`,
        context ? `Context: ${context}` : '',
        `The draft plan:\n${JSON.stringify(draft, null, 2)}`,
        `The draft's longest dependency chain is ${draftChain.path.join(' → ')}, about ${draftChain.minutes} of ${draftChain.total} estimated minutes. The sprint cannot finish sooner than that chain: shorten it where you can, by splitting a link or by dropping a dependency that only shares a convention (write the convention into the contracts instead).`,
        draftLong.length ? `Tickets estimated over 10 minutes, which should be split: ${draftLong.map(t => `${t.id} (${t.estimateMin} min)`).join(', ')}.` : '',
        PLAN_RULES,
        'Fix what is wrong: missing work, tickets too big to finish in a few minutes (split them) or too small to be worth an agent (merge them), vague tasks, acceptance conditions nobody can check, kinds marked too low for the risk, estimates that look wrong, dependency chains longer than they need to be, and file collisions between tickets that can run at the same time. Keep what is right. Do not change any files.',
      ].filter(Boolean).join('\n\n'),
      tierOpts(TOP_HIGH, 'plan critic', 'Decide', CRITIQUED),
    )
  } catch (e) {
    criticError = e && e.message ? e.message : String(e)
    critiqued = null
    log(`The plan critic failed (${criticError}), so the draft runs as is.`)
  }
  plan = critiqued || draft
  log(`Plan: ${plan.tickets.length} tickets. ${critiqued ? `Critic: ${critiqued.changes}` : criticError ? 'The draft runs as is.' : 'The critic returned nothing, so the draft runs as is.'}`)
}

const first = normalizeTickets(plan.tickets, givenIssues.length ? 'F' : '', used)
const dropped = [...first.dropped]
const chain = chainOf(first.tickets)
log(`Plan: ${first.tickets.length} tickets, about ${chain.total} agent-minutes; longest chain ${chain.path.join(' → ')} about ${chain.minutes} min, so the build takes about that long plus integration.`)
let results = await runRound(first.tickets, briefOf(plan, 0))
let { integration, final } = await closeOut(results, plan, briefOf(plan, 0))
const rounds = [{ round: 0, tickets: first.tickets.length, verdict: final ? final.verdict : 'not reviewed' }]
let lastReal = final ? { final, round: 0 } : null

let fixNo = 0
while (final && final.verdict === 'fix first' && final.issues.length && fixNo < fixRounds && !overCap()) {
  fixNo += 1
  log(`The final review says fix first (${final.issues.length} issues): starting fix round ${fixNo}.`)
  let fixPlan = null
  try {
    fixPlan = await agent(triagePrompt(final.issues, fixNo), tierOpts(TOP_HIGH, 'fix plan', 'Decide', PLAN))
  } catch (e) {
    log(`Fix round ${fixNo} has no plan: the triage agent failed (${e && e.message ? e.message : String(e)}).`)
    break
  }
  if (!fixPlan) {
    log(`Fix round ${fixNo} has no plan: the triage agent returned nothing.`)
    break
  }
  const fix = normalizeTickets(fixPlan.tickets, 'F', used)
  dropped.push(...fix.dropped)
  const merged = { ...plan, contracts: `${plan.contracts}\n\nFix round ${fixNo}: ${fixPlan.contracts}`, checks: plan.checks || fixPlan.checks }
  const fixBrief = briefOf({ approach: `${plan.approach}\n\nFix round ${fixNo}: ${fixPlan.approach}`, contracts: merged.contracts }, fixNo)
  results = [...results, ...(await runRound(fix.tickets, fixBrief))]
  ;({ integration, final } = await closeOut(results, merged, fixBrief))
  rounds.push({ round: fixNo, tickets: fix.tickets.length, verdict: final ? final.verdict : 'not reviewed' })
  if (final) lastReal = { final, round: fixNo }
  else if (lastReal) {
    const why = overCap() ? `hit ${overCap()}` : 'the reviewer returned nothing'
    const name = lastReal.round ? `fix round ${lastReal.round}` : 'first round'
    log(`Fix round ${fixNo}'s final review did not finish (${why}); keeping the ${name} verdict and its ${lastReal.final.issues.length} open issues.`)
  }
}
const reported = lastReal ? lastReal.final : null
const ran = rounds.length - 1
if (final && final.verdict === 'fix first') log(ran ? `The final review still says fix first after ${ran} fix round${ran === 1 ? '' : 's'}; its issues are in openIssues.` : 'The final review says fix first and no fix round ran; its issues are in openIssues.')

return {
  goal,
  approach: plan.approach,
  planChanges: critiqued ? critiqued.changes : givenIssues.length ? 'triaged from known issues, no planner' : criticError ? `the critic failed (${criticError})` : 'the critic returned nothing',
  criticalPath: `${chain.path.join(' → ')} (about ${chain.minutes} of ${chain.total} min)`,
  tickets: results.map(
    r => `${r.id} ${r.status} [${r.tiers.join(' → ') || 'not run'}] ~${r.estimateMin}m ${r.title}: ${r.summary}${r.status === 'failed' ? ` | open: ${r.issues.join('; ')}` : ''}`,
  ),
  dropped,
  rounds: rounds.map(r => (r.round ? `fix round ${r.round}: ${r.tickets} tickets, ${r.verdict}` : `first round: ${r.tickets} tickets, ${r.verdict}`)),
  integration: integration ? integration.summary : 'not run',
  checks: integration ? integration.checks.map(c => `${c.passed ? 'pass' : 'FAIL'} ${c.command}`) : [],
  verdict: reported ? reported.verdict : 'not reviewed',
  finalSummary: reported ? reported.summary : '',
  openIssues: reported ? reported.issues : integration ? integration.remaining : [],
  polish: reported ? reported.polish : [],
}
