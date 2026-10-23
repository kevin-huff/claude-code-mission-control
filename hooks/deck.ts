import type { AgentRow, Code, Deck, FeedItem, FeedKind, Guards, Limit, Minute, PlanTicket, RunRow, Timeline, ToolRun, Usage } from '../types'

export const MAIN = 'main'
export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Level = (typeof LADDER)[number]

const BUCKET_MS = 2_000
const MAX_CODES = 480
const HIDDEN_THINK_MS = 5_000
const LONG_TOOL_MS = 60_000
const STUCK_SHARE = 0.85
const LONG_THINK_MS = 6 * 60_000
const BASH_LIMIT_MS = 120_000
const RUN_SETTLE_MS = 15_000
const KEEP_RUNS = 6
const KEEP_LOOSE = 24
const HEAD_MAX = 8_192
const ESCALATE_AFTER = 2
const FEED_MAX = 60
const MINUTES_KEPT = 60
const RECENT_MAX = 4
const RANK: Record<Code, number> = { s: 7, l: 6, w: 5, t: 4, b: 3, x: 2, q: 1, i: 0 }
const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])
const GUARDS: [keyof Guards, RegExp, string][] = [
  ['search', /Blocked by the search guard/, 'search guard'],
  ['effort', /Blocked by the effort guard/, 'effort guard'],
  ['disk', /Blocked by the Windows disk guard/, 'disk guard'],
]

type Counts = Partial<Record<Code, number>>
type Acc = { bucket: number; counts: Counts }

export type Store = {
  agents: Map<string, AgentRow>
  runs: Map<string, RunRow>
  runNames: Map<string, string>
  runLimits: Map<string, number>
  journals: Map<string, { seen: number; done: boolean; labels: Map<string, string> }>
  heads: Map<string, string>
  acc: Map<string, Acc>
  warned: Set<string>
  transcriptDir: string | null
  feed: FeedItem[]
  minutes: Map<number, { tokens: number; live: number }>
  usage: Usage | null
  guards: Guards
  autoEscalate: boolean
  dirty: boolean
}

export type SpawnFacts = {
  agentId: string
  description: string
  subagentType: string
  model: string
  runId: string | null
  index: number | null
  toolUseId: string
  isTeammate: boolean
}

export type Usage4 = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
} | null

export function createStore(): Store {
  return {
    agents: new Map(),
    runs: new Map(),
    runNames: new Map(),
    runLimits: new Map(),
    journals: new Map(),
    heads: new Map(),
    acc: new Map(),
    warned: new Set(),
    transcriptDir: null,
    feed: [],
    minutes: new Map(),
    usage: null,
    guards: { search: 0, effort: 0, disk: 0 },
    autoEscalate: true,
    dirty: false,
  }
}

export function emptyDeck(): Deck {
  return { at: 0, main: null, agents: [], runs: [], transcriptDir: null, feed: [], minutes: [], usage: null, guards: { search: 0, effort: 0, disk: 0 } }
}

function healRow(row: AgentRow): AgentRow {
  row.baseEffort ??= row.effort ?? null
  row.bumps ??= 0
  row.fails ??= 0
  row.window ??= 200_000
  row.lastRate ??= 0
  row.recent ??= []
  return row
}

// Rows come back from $.state frozen and possibly from an older shape: copy and fill.
export function restore(store: Store, deck: Deck): void {
  const copy = JSON.parse(JSON.stringify(deck)) as Partial<Deck>
  for (const row of copy.agents ?? []) store.agents.set(row.id, healRow(row))
  if (copy.main) store.agents.set(MAIN, healRow(copy.main))
  for (const run of copy.runs ?? []) store.runs.set(run.id, { ...run, draft: run.draft ?? (run.planFrom === 'planner' && run.plan ? run.plan.filter(t => t.from === undefined) : null), plan: run.plan ?? null, planFrom: run.planFrom ?? null, verdicts: run.verdicts ?? {}, final: run.final ?? null, finals: run.finals ?? {}, limitBase: run.limitBase ?? null, maxTickets: run.maxTickets ?? null })
  store.transcriptDir ??= copy.transcriptDir ?? null
  store.feed = copy.feed ?? []
  for (const [minute, tokens, live] of copy.minutes ?? []) store.minutes.set(minute, { tokens, live })
  store.usage = copy.usage ?? null
  store.guards = { search: 0, effort: 0, disk: 0, ...(copy.guards ?? {}) }
}

function say(store: Store, kind: FeedKind, text: string, at: number): void {
  store.feed.push({ at, kind, text })
  if (store.feed.length > FEED_MAX) store.feed.splice(0, store.feed.length - FEED_MAX)
  store.dirty = true
}

function blankRow(id: string, label: string, type: string, now: number): AgentRow {
  return {
    id, label, type,
    runId: null, index: 0, model: null, effort: null, baseEffort: null, bumps: 0, fails: 0,
    startedAt: now, endedAt: null, outcome: null,
    code: 'q', since: now, step: 0, stepSince: null,
    compose: null, tools: [], toolCalls: 0, errors: 0, ctx: 0, window: 200_000, out: 0, lastRate: 0, note: '',
    recent: [], tl: { origin: now, size: BUCKET_MS, codes: '' },
  }
}

function rowFor(store: Store, agentId: string | undefined, now: number): AgentRow {
  const id = agentId ?? MAIN
  let row = store.agents.get(id)
  if (!row) {
    row = id === MAIN ? blankRow(MAIN, 'this chat', 'main', now) : blankRow(id, `agent ${id.slice(0, 7)}`, 'agent', now)
    if (id === MAIN) row.code = 'i'
    store.agents.set(id, row)
  }
  return row
}

function setCode(row: AgentRow, code: Code, now: number, keepSince = false): void {
  if (row.code === code) return
  row.code = code
  if (!keepSince) row.since = now
}

export function isLevel(x: unknown): x is Level {
  return typeof x === 'string' && (LADDER as readonly string[]).includes(x)
}

export function modelShort(model: string | null): string {
  if (!model) return ''
  const m = /(haiku|sonnet|opus|fable)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : model.replace(/^claude-/, '').slice(0, 8)
}

export function oldestTool(row: AgentRow): ToolRun | undefined {
  let oldest: ToolRun | undefined
  for (const tool of row.tools) if (!oldest || tool.since < oldest.since) oldest = tool
  return oldest
}

// What the pane shows: the raw code, sharpened by how long it has lasted. A request with
// nothing streamed after a few seconds is hidden thinking, since replies start fast.
export function displayCode(row: AgentRow, now: number): Code {
  const tool = oldestTool(row)
  if (tool) {
    const ran = now - tool.since
    if (tool.limitMs !== null && tool.limitMs >= LONG_TOOL_MS && ran >= STUCK_SHARE * tool.limitMs) return 's'
    return ran >= LONG_TOOL_MS ? 'l' : 'b'
  }
  if (row.code === 'q' && row.stepSince !== null && now - row.since >= HIDDEN_THINK_MS) {
    return now - row.since >= LONG_THINK_MS ? 's' : 't'
  }
  if (row.code === 't' && now - row.since >= LONG_THINK_MS) return 's'
  return row.code
}

export function isLive(row: AgentRow): boolean {
  return row.endedAt === null && !(row.id === MAIN && row.code === 'i')
}

export function anyLive(store: Store): boolean {
  for (const row of store.agents.values()) if (isLive(row)) return true
  return false
}

function majority(counts: Counts): Code | undefined {
  let best: Code | undefined
  let most = 0
  for (const key of Object.keys(counts) as Code[]) {
    const n = counts[key] ?? 0
    if (n > most || (n === most && best !== undefined && RANK[key] > RANK[best])) {
      best = key
      most = n
    }
  }
  return best
}

export function stronger(a: Code | null, b: Code | null): Code | null {
  if (a === null) return b
  if (b === null) return a
  return RANK[b] > RANK[a] ? b : a
}

function halve(tl: Timeline): void {
  let out = ''
  for (let i = 0; i < tl.codes.length; i += 2) {
    const a = tl.codes.charAt(i) as Code
    const b = tl.codes.charAt(i + 1)
    out += b !== '' && RANK[b as Code] > RANK[a] ? b : a
  }
  tl.codes = out
  tl.size *= 2
}

function seal(tl: Timeline, bucket: number, code: Code): void {
  if (bucket < tl.codes.length) return
  tl.codes += code.repeat(bucket - tl.codes.length + 1)
  while (tl.codes.length > MAX_CODES) halve(tl)
}

export function sample(store: Store, row: AgentRow, code: Code, now: number): void {
  const bucket = Math.floor((now - row.tl.origin) / row.tl.size)
  const acc = store.acc.get(row.id)
  if (!acc) {
    store.acc.set(row.id, { bucket, counts: { [code]: 1 } })
    return
  }
  if (bucket > acc.bucket) {
    seal(row.tl, acc.bucket, majority(acc.counts) ?? code)
    acc.bucket = Math.floor((now - row.tl.origin) / row.tl.size)
    acc.counts = {}
  }
  acc.counts[code] = (acc.counts[code] ?? 0) + 1
}

function closeOut(store: Store, row: AgentRow, now: number): void {
  const acc = store.acc.get(row.id)
  if (acc) seal(row.tl, acc.bucket, majority(acc.counts) ?? displayCode(row, now))
  store.acc.delete(row.id)
}

// The strip: `width` cells over [from, to], each the commonest state of the buckets under it.
export function cells(row: AgentRow, from: number, to: number, width: number, now: number): (Code | null)[] {
  const out: (Code | null)[] = []
  const span = Math.max(1, to - from)
  const end = row.endedAt ?? now
  const tl = row.tl
  const tail = row.endedAt === null ? displayCode(row, now) : undefined
  for (let c = 0; c < width; c++) {
    const a = Math.max(from + (c * span) / width, row.startedAt)
    const b = Math.min(from + ((c + 1) * span) / width, end)
    if (b <= a) {
      out.push(null)
      continue
    }
    const lo = Math.max(0, Math.floor((a - tl.origin) / tl.size))
    const hi = Math.max(lo, Math.floor((b - tl.origin - 1) / tl.size))
    const counts: Counts = {}
    for (let i = lo; i <= Math.min(hi, tl.codes.length - 1); i++) {
      const k = tl.codes.charAt(i) as Code
      counts[k] = (counts[k] ?? 0) + 1
    }
    if (hi >= tl.codes.length && tail) counts[tail] = (counts[tail] ?? 0) + 1
    out.push(majority(counts) ?? null)
  }
  return out
}

export type Shares = { think: number; write: number; text: number; tools: number; stuck: number; wait: number }

const SHARE_OF: Partial<Record<Code, keyof Shares>> = { t: 'think', w: 'write', x: 'text', b: 'tools', l: 'tools', s: 'stuck', q: 'wait' }

// Where the agents' time went, from their timelines, idle time left out.
export function shares(rows: readonly AgentRow[]): Shares | null {
  const ms: Shares = { think: 0, write: 0, text: 0, tools: 0, stuck: 0, wait: 0 }
  let total = 0
  for (const row of rows) {
    for (const ch of row.tl.codes) {
      const key = SHARE_OF[ch as Code]
      if (!key) continue
      ms[key] += row.tl.size
      total += row.tl.size
    }
  }
  if (total < 10_000) return null
  for (const key of Object.keys(ms) as (keyof Shares)[]) ms[key] = Math.round((100 * ms[key]) / total)
  return ms
}

function settleRuns(store: Store, now: number): void {
  for (const run of store.runs.values()) {
    let live = false
    let count = 0
    let last = 0
    for (const row of store.agents.values()) {
      if (row.runId !== run.id) continue
      count += 1
      if (row.endedAt === null) live = true
      else last = Math.max(last, row.endedAt)
    }
    if (live) {
      run.endedAt = null
    } else if (count && run.endedAt === null && now - last >= RUN_SETTLE_MS) {
      run.endedAt = last
      say(store, 'run', `${run.name} finished in ${clock(last - run.startedAt)} · ${count} agents`, now)
    }
  }
}

function minuteSlot(store: Store, now: number): { tokens: number; live: number } {
  const minute = Math.floor(now / 60_000)
  let slot = store.minutes.get(minute)
  if (!slot) {
    slot = { tokens: 0, live: 0 }
    store.minutes.set(minute, slot)
    for (const key of store.minutes.keys()) if (key < minute - MINUTES_KEPT) store.minutes.delete(key)
  }
  return slot
}

// Once a second: sample each live agent's state into its timeline, count who is live this
// minute, and say which tools have just passed most of their time limit.
export function tick(store: Store, now: number): string[] {
  const warnings: string[] = []
  let live = 0
  for (const row of store.agents.values()) {
    if (row.endedAt !== null || row.id === MAIN) continue
    live += 1
    const code = displayCode(row, now)
    sample(store, row, code, now)
    const tool = code === 's' ? oldestTool(row) : undefined
    if (tool && tool.limitMs !== null && !store.warned.has(tool.id)) {
      store.warned.add(tool.id)
      const text = `${row.label}: "${tool.label || tool.tool}" has run ${clock(now - tool.since)} of its ${clock(tool.limitMs)} limit`
      warnings.push(text)
      say(store, 'warn', text, now)
    }
  }
  const slot = minuteSlot(store, now)
  slot.live = Math.max(slot.live, live)
  settleRuns(store, now)
  return warnings
}

function dropRow(store: Store, id: string): void {
  store.agents.delete(id)
  store.acc.delete(id)
  store.heads.delete(id)
}

function prune(store: Store): void {
  const runs = [...store.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  for (const run of runs.slice(KEEP_RUNS)) {
    store.runs.delete(run.id)
    store.journals.delete(run.id)
    for (const row of [...store.agents.values()]) if (row.runId === run.id) dropRow(store, row.id)
  }
  const loose = [...store.agents.values()]
    .filter(row => row.runId === null && row.id !== MAIN && row.endedAt !== null)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  for (const row of loose.slice(KEEP_LOOSE)) dropRow(store, row.id)
}

export function clearFinished(store: Store): void {
  for (const run of [...store.runs.values()]) {
    if (run.endedAt === null) continue
    store.runs.delete(run.id)
    store.journals.delete(run.id)
    for (const row of [...store.agents.values()]) if (row.runId === run.id) dropRow(store, row.id)
  }
  for (const row of [...store.agents.values()]) {
    if (row.runId === null && row.id !== MAIN && row.endedAt !== null) dropRow(store, row.id)
  }
  store.dirty = true
}

// The workflow call's maxTickets argument, clamped the way the sprint workflow clamps it, for spawned() to copy onto its run.
export function noteLimit(store: Store, toolUseId: string, args: unknown): void {
  // The workflow reads string args as its goal, so a string carries no ticket limit.
  const o: unknown = typeof args === 'string' ? null : args
  const asked = o && typeof o === 'object' ? (o as Record<string, unknown>)['maxTickets'] : undefined
  store.runLimits.set(toolUseId, Math.max(1, Math.min(40, Number(asked) || 16)))
}

export function spawned(store: Store, f: SpawnFacts, now: number): void {
  if (f.runId) {
    const run = store.runs.get(f.runId)
    if (run) {
      run.endedAt = null
      run.maxTickets ??= store.runLimits.get(f.toolUseId) ?? null
    } else {
      const name = store.runNames.get(f.toolUseId) ?? 'workflow'
      store.runs.set(f.runId, { id: f.runId, name, dir: store.transcriptDir, startedAt: now, endedAt: null, phases: {},
        plan: null, draft: null, planFrom: null, verdicts: {}, final: null, finals: {},
        limitBase: store.usage?.fiveHour ? { ...store.usage.fiveHour } : null,
        maxTickets: store.runLimits.get(f.toolUseId) ?? null,
      })
      say(store, 'run', name === 'workflow' ? 'a workflow started' : `workflow ${name} started`, now)
    }
  }
  const known = store.agents.get(f.agentId)
  if (known) {
    known.endedAt = null
    known.outcome = null
    setCode(known, 'q', now)
  } else {
    const row = blankRow(f.agentId, f.description || f.subagentType || 'agent', f.isTeammate ? 'teammate' : f.subagentType, now)
    row.runId = f.runId
    row.index = f.index ?? store.agents.size
    row.model = f.model || null
    store.agents.set(f.agentId, row)
    say(store, 'start', `${row.label} started${row.model ? ` · ${modelShort(row.model)}` : ''}`, now)
  }
  prune(store)
  store.dirty = true
}

export function turnStarted(store: Store, agentId: string | undefined, now: number): void {
  const row = rowFor(store, agentId, now)
  if (row.endedAt !== null) {
    row.endedAt = null
    row.outcome = null
  }
  setCode(row, 'q', now)
  store.dirty = true
}

export function stepStarted(store: Store, agentId: string | undefined, facts: { effort?: string | number; model: string }, now: number): void {
  const row = rowFor(store, agentId, now)
  row.step += 1
  row.stepSince = now
  row.compose = null
  if (facts.effort !== undefined) {
    const asked = String(facts.effort)
    row.baseEffort ??= asked
    if (!row.bumps) row.effort = asked
  }
  row.model = facts.model
  if (/\[1m\]/i.test(facts.model)) row.window = 1_000_000
  row.code = 'q'
  row.since = now
  store.dirty = true
}

// The effort a subagent's next request should carry when Mission Control has raised it.
export function effortToSend(store: Store, agentId: string | undefined, asked: unknown): Level | undefined {
  if (agentId === undefined) return undefined
  const row = store.agents.get(agentId)
  if (!row || !row.bumps || !isLevel(row.effort)) return undefined
  if (isLevel(asked) && LADDER.indexOf(asked) >= LADDER.indexOf(row.effort)) return undefined
  return row.effort
}

export function streamed(store: Store, agentId: string | undefined, kind: 'thinking' | 'text', now: number): void {
  const row = rowFor(store, agentId, now)
  if (kind === 'thinking') setCode(row, 't', now, row.code === 'q')
  else setCode(row, 'x', now)
  store.dirty = true
}

export function composing(store: Store, agentId: string | undefined, tool: string, now: number): void {
  const row = rowFor(store, agentId, now)
  row.compose = { tool, target: '', bytes: 0 }
  store.heads.set(row.id, '')
  setCode(row, 'w', now)
  store.dirty = true
}

export function composed(store: Store, agentId: string | undefined, json: string): void {
  const row = store.agents.get(agentId ?? MAIN)
  if (!row || !row.compose) return
  row.compose.bytes += json.length
  if (row.compose.target) return
  const head = (store.heads.get(row.id) ?? '') + json
  if (head.length > HEAD_MAX) return
  store.heads.set(row.id, head)
  row.compose.target = targetOf(head)
}

export function stepStopped(store: Store, agentId: string | undefined, usage: Usage4, now: number): void {
  const row = store.agents.get(agentId ?? MAIN)
  if (!row || !usage) return
  row.ctx = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  if (row.ctx > row.window) row.window = 1_000_000
  const out = usage.output_tokens ?? 0
  row.out += out
  if (row.stepSince !== null && now > row.stepSince) row.lastRate = Math.round(out / ((now - row.stepSince) / 1000))
  minuteSlot(store, now).tokens += out
  store.dirty = true
}

export function toolStarted(store: Store, agentId: string | undefined, run: ToolRun, now: number): void {
  const row = rowFor(store, agentId, now)
  row.toolCalls += 1
  row.tools = [...row.tools.filter(tool => tool.id !== run.id), run]
  row.compose = null
  if (run.label) row.note = run.label
  setCode(row, 'b', now)
  store.dirty = true
}

// A tool call came back. Returns a sentence when this failure raised the agent's effort.
export function toolEnded(store: Store, agentId: string | undefined, toolUseId: string, failed: boolean, now: number, text = ''): string | null {
  const row = store.agents.get(agentId ?? MAIN)
  if (!row) return null
  const run = row.tools.find(tool => tool.id === toolUseId)
  row.tools = row.tools.filter(tool => tool.id !== toolUseId)
  store.warned.delete(toolUseId)
  if (run) {
    row.recent.push({ tool: run.tool, label: run.label, ok: !failed, ms: now - run.since })
    if (row.recent.length > RECENT_MAX) row.recent.splice(0, row.recent.length - RECENT_MAX)
  }
  let raised: string | null = null
  if (failed) {
    row.errors += 1
    row.fails += 1
    const guard = GUARDS.find(([, re]) => re.test(text))
    if (guard) {
      store.guards[guard[0]] += 1
      say(store, 'guard', `${guard[2]} stopped ${row.label}${run?.label ? `: ${run.label}` : ''}`, now)
    } else if (row.id !== MAIN && run) {
      say(store, 'fail', `${row.label}: ${run.tool}${run.label ? ` · ${run.label}` : ''} failed`, now)
    }
    if (store.autoEscalate && row.id !== MAIN && row.endedAt === null && row.fails >= ESCALATE_AFTER && isLevel(row.effort) && row.effort !== 'max') {
      const from = row.effort
      const to = LADDER[LADDER.indexOf(from) + 1] ?? 'max'
      row.effort = to
      row.bumps += 1
      row.fails = 0
      raised = `${row.label}: effort raised ${from} → ${to} after ${ESCALATE_AFTER} failed commands in a row`
      say(store, 'up', raised, now)
    }
  } else {
    row.fails = 0
  }
  if (row.tools.length === 0 && row.endedAt === null) setCode(row, 'q', now)
  store.dirty = true
  return raised
}

export function turnEnded(store: Store, agentId: string | undefined, reason: string, now: number): void {
  const row = rowFor(store, agentId, now)
  row.tools = []
  row.compose = null
  row.stepSince = null
  if (row.id !== MAIN && row.type !== 'teammate') {
    closeOut(store, row, now)
    row.endedAt = now
    row.outcome = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
    const took = clock(now - row.startedAt)
    say(
      store,
      row.outcome === 'done' ? 'done' : 'fail',
      row.outcome === 'done'
        ? `${row.label} finished in ${took} · ${row.step} steps · ${row.toolCalls} commands`
        : `${row.label} ${row.outcome} after ${took}`,
      now,
    )
  }
  setCode(row, 'i', now)
  store.dirty = true
}

function limitOf(v: unknown): Limit | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { used_percentage?: unknown; resets_at?: unknown }
  if (typeof o.used_percentage !== 'number') return null
  const raw = o.resets_at
  const resetsAt = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) || 0 : 0
  return { pct: o.used_percentage, resetsAt }
}

// The status line script saves Claude Code's status JSON; the usage limits are the account's,
// the cost and context only this session's when the capture is ours.
export function absorbStatus(store: Store, text: string, sessionId: string | null): void {
  let d: { rate_limits?: { five_hour?: unknown; seven_day?: unknown }; cost?: { total_cost_usd?: unknown }; context_window?: { used_percentage?: unknown }; session_id?: unknown }
  try {
    d = JSON.parse(text) as typeof d
  } catch {
    return
  }
  const ours = sessionId !== null && d.session_id === sessionId
  const prior = store.usage
  store.usage = {
    fiveHour: limitOf(d.rate_limits?.five_hour) ?? prior?.fiveHour ?? null,
    sevenDay: limitOf(d.rate_limits?.seven_day) ?? prior?.sevenDay ?? null,
    costUsd: ours && typeof d.cost?.total_cost_usd === 'number' ? d.cost.total_cost_usd : prior?.costUsd ?? null,
    ctxPct: ours && typeof d.context_window?.used_percentage === 'number' ? d.context_window.used_percentage : prior?.ctxPct ?? null,
  }
  const five = store.usage.fiveHour
  if (five) for (const run of store.runs.values()) if (run.endedAt === null && run.limitBase === null) run.limitBase = { ...five }
  store.dirty = true
}

function copyRow(row: AgentRow): AgentRow {
  return {
    ...row,
    tools: row.tools.map(tool => ({ ...tool })),
    compose: row.compose ? { ...row.compose } : null,
    recent: row.recent.map(r => ({ ...r })),
    tl: { ...row.tl },
  }
}

export function snapshot(store: Store, now: number): Deck {
  const main = store.agents.get(MAIN)
  const minutes: Minute[] = [...store.minutes.entries()].sort((a, b) => a[0] - b[0]).map(([m, s]) => [m, s.tokens, s.live])
  return {
    at: now,
    main: main ? copyRow(main) : null,
    agents: [...store.agents.values()].filter(row => row.id !== MAIN).map(copyRow),
    runs: [...store.runs.values()].map(run => ({
      ...run,
      phases: { ...run.phases },
      plan: run.plan ? run.plan.map(t => ({ ...t, dependsOn: [...t.dependsOn] })) : null,
      draft: run.draft ? run.draft.map(t => ({ ...t, dependsOn: [...t.dependsOn] })) : null,
      verdicts: Object.fromEntries(Object.entries(run.verdicts).map(([k, v]) => [k, { ...v }])),
      final: run.final ? { ...run.final } : null,
      finals: Object.fromEntries(Object.entries(run.finals).map(([k, v]) => [k, { ...v }])),
      limitBase: run.limitBase ? { ...run.limitBase } : null,
    })),
    transcriptDir: store.transcriptDir,
    feed: store.feed.map(item => ({ ...item })),
    minutes,
    usage: store.usage ? { ...store.usage } : null,
    guards: { ...store.guards },
  }
}

export function journalPath(run: RunRow): string | null {
  return run.dir ? `${run.dir}/subagents/workflows/${run.id}/journal.jsonl` : null
}

// A run has no folder when it began before this session's folder was known, or when an older pane recorded
// it. Its journal is most likely in this session's folder, so it adopts that one; a miss marks the journal gone.
export function adoptDir(store: Store, run: RunRow): void {
  if (!run.dir && store.transcriptDir) run.dir = store.transcriptDir
}

const PLAN_MAX = 40
const FIX_MAX = 2 * PLAN_MAX
const DEFAULT_TICKETS = 16
const REVIEW_RE = /^(\S+) review(?: (\d+)\/(\d+))? \(/

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function record(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
}

function slimTicket(t: Record<string, unknown>, id: string, dependsOn: string[]): PlanTicket {
  const est = t['estimateMin']
  return {
    id,
    title: typeof t['title'] === 'string' ? cut(t['title'], 80) : id,
    kind: typeof t['kind'] === 'string' ? t['kind'] : 'judgment',
    dependsOn,
    estimateMin: typeof est === 'number' && est > 0 ? est : null,
  }
}

function slimPlan(tickets: unknown[]): PlanTicket[] {
  const out: PlanTicket[] = []
  const seen = new Set<string>()
  for (const raw of tickets) {
    if (out.length >= PLAN_MAX) break
    const t = record(raw)
    let id = typeof t['id'] === 'string' ? t['id'].trim() : ''
    if (!id) continue
    while (seen.has(id)) id += "'"
    seen.add(id)
    out.push(slimTicket(t, id, Array.isArray(t['dependsOn']) ? t['dependsOn'].filter((d): d is string => typeof d === 'string') : []))
  }
  return out
}

// The workflow runs only the first maxTickets of each plan; the rest stay, marked, so numbering matches it.
function cap(run: RunRow, plan: PlanTicket[]): PlanTicket[] {
  const limit = run.maxTickets ?? DEFAULT_TICKETS
  plan.forEach((t, i) => {
    if (i >= limit) t.dropped = true
  })
  return plan
}

const kept = (plan: PlanTicket[]) => plan.filter(t => !t.dropped).length

const copyTickets = (plan: PlanTicket[]): PlanTicket[] => plan.map(t => ({ ...t, dependsOn: [...t.dependsOn] }))

function takePlan(store: Store, run: RunRow, from: 'planner' | 'critic', tickets: unknown[], now: number): void {
  if (from === 'planner' && run.planFrom === 'critic') return
  const plan = cap(run, slimPlan(tickets))
  const fixes = (run.plan ?? []).filter(t => t.from !== undefined)
  const before = (run.plan ?? []).filter(t => t.from === undefined)
  if (from === 'critic' && run.draft === null && run.planFrom === 'planner') run.draft = copyTickets(before)
  if (run.planFrom === from && JSON.stringify(plan) === JSON.stringify(before)) return
  run.plan = [...plan, ...fixes]
  if (from === 'planner') run.draft = copyTickets(plan)
  run.planFrom = from
  store.dirty = true
  const n = kept(plan)
  say(store, 'run', from === 'critic' ? `plan checked: ${n} tickets` : `draft plan ready: ${n} tickets`, now)
}

// A triage agent's tickets, renamed F1, F2, ... past every id already used, the way the workflow's normalizeTickets does.
function takeFixPlan(store: Store, run: RunRow, agentId: string, tickets: unknown[], now: number): void {
  const others = (run.plan ?? []).filter(t => t.from !== agentId)
  const used = new Set(others.map(t => t.id))
  const rename = new Map<string, string>()
  const raws = tickets.slice(0, FIX_MAX).map(record)
  const ids: string[] = []
  for (const t of raws) {
    const asked = String(t['id'] ?? '').trim()
    let n = 1
    while (used.has(`F${n}`)) n += 1
    const id = `F${n}`
    used.add(id)
    ids.push(id)
    if (asked && !rename.has(asked)) rename.set(asked, id)
  }
  const mine = new Set(ids)
  const plan = cap(
    run,
    raws.map((t, i) => {
      const id = ids[i]!
      const asked = Array.isArray(t['dependsOn']) ? t['dependsOn'].map(String) : []
      const deps = [...new Set(asked.map(d => rename.get(d) ?? d))].filter(d => d !== id && mine.has(d))
      return { ...slimTicket(t, id, deps), from: agentId }
    }),
  )
  const before = (run.plan ?? []).filter(t => t.from === agentId)
  if (JSON.stringify(plan) === JSON.stringify(before)) return
  run.plan = [...others, ...plan]
  store.dirty = true
  say(store, 'run', `fix plan ready: ${kept(plan)} tickets`, now)
}

function takeResult(store: Store, run: RunRow, agentId: string, label: string, result: Record<string, unknown>, now: number): void {
  if (label.startsWith('fix plan (')) {
    if (Array.isArray(result['tickets'])) takeFixPlan(store, run, agentId, result['tickets'], now)
  } else if (label.startsWith('plan critic (')) {
    if (Array.isArray(result['tickets'])) takePlan(store, run, 'critic', result['tickets'], now)
  } else if (label.startsWith('plan (')) {
    if (Array.isArray(result['tickets'])) takePlan(store, run, 'planner', result['tickets'], now)
  } else if (label.startsWith('final review (')) {
    if (typeof result['verdict'] !== 'string') return
    const next = { verdict: result['verdict'], summary: cut(String(result['summary'] ?? ''), 140) }
    const had = run.finals[agentId]
    if (had && had.verdict === next.verdict && had.summary === next.summary) return
    run.finals[agentId] = next
    run.final = next
    store.dirty = true
    if (!had) say(store, 'run', `final review: ${next.verdict} \u00b7 ${next.summary}`, now)
  } else {
    const m = REVIEW_RE.exec(label)
    if (!m || typeof result['pass'] !== 'boolean' || run.verdicts[agentId]) return
    const issues = result['issues']
    const issue = Array.isArray(issues) && issues.length > 0 ? cut(String(issues[0]), 160) : ''
    const verdict = { pass: result['pass'], summary: cut(String(result['summary'] ?? ''), 140), issue }
    run.verdicts[agentId] = verdict
    store.dirty = true
    if (verdict.pass) say(store, 'done', `${m[1]} passed review${m[2] ? ` (try ${m[2]} of ${m[3]})` : ''}`, now)
    else say(store, 'fail', `${m[1]} failed review: ${issue || verdict.summary}`, now)
  }
}

// The run's journal says which phase each agent belongs to, its label as the script wrote it, and what each agent handed back.
// Safe to call again with the whole file: only whole lines are read, and only from where the last read stopped.
export function absorbJournal(store: Store, runId: string, text: string, now = 0): void {
  const run = store.runs.get(runId)
  if (!run) return
  let entry = store.journals.get(runId)
  if (!entry) {
    entry = { seen: 0, done: false, labels: new Map() }
    store.journals.set(runId, entry)
  }
  if (text.length < entry.seen) {
    entry.seen = 0
    entry.labels.clear()
  }
  const end = text.lastIndexOf('\n') + 1
  if (end > entry.seen) {
    for (const line of text.slice(entry.seen, end).split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as { type?: string; agentId?: string; label?: string; phase?: string; result?: unknown }
        if (!e || !e.agentId) continue
        if (e.type === 'started') {
          if (e.phase && run.phases[e.agentId] !== e.phase) {
            run.phases[e.agentId] = e.phase
            store.dirty = true
          }
          if (e.label) entry.labels.set(e.agentId, e.label)
          const row = store.agents.get(e.agentId)
          if (row && e.label && row.label !== e.label) {
            row.label = e.label
            store.dirty = true
          }
        } else if (e.type === 'result' && e.result && typeof e.result === 'object') {
          const label = entry.labels.get(e.agentId) ?? store.agents.get(e.agentId)?.label ?? ''
          takeResult(store, run, e.agentId, label, e.result as Record<string, unknown>, now)
        }
      } catch {
        continue
      }
    }
    entry.seen = end
  }
  entry.done = run.endedAt !== null
}

export function journalWanted(store: Store, run: RunRow): boolean {
  return run.endedAt === null || !store.journals.get(run.id)?.done
}

const PATH_RE = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/
const DESC_RE = /"(?:description|pattern|query|url|skill)"\s*:\s*"((?:[^"\\]|\\.)*)"/

function unjson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`
}

export function targetOf(head: string): string {
  const path = PATH_RE.exec(head)
  if (path?.[1]) return shortPath(unjson(path[1]))
  const desc = DESC_RE.exec(head)
  return desc?.[1] ? unjson(desc[1]) : ''
}

export function isWriter(tool: string): boolean {
  return WRITERS.has(tool)
}

function str(e: Record<string, unknown>, key: string): string {
  const v = e[key]
  return typeof v === 'string' ? v : ''
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0] ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export function workflowName(script: string): string {
  const m = /\bmeta\s*=\s*\{[\s\S]{0,600}?\bname\s*:\s*(['"`])([^'"`\n]{1,80})\1/.exec(script)
  return m?.[2] ?? ''
}

export function toolLabel(e: Record<string, unknown>): string {
  switch (String(e['tool'])) {
    case 'Bash':
      return str(e, 'description') || firstLine(str(e, 'command'))
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortPath(str(e, 'file_path') || str(e, 'notebook_path'))
    case 'Grep':
    case 'Glob':
      return str(e, 'pattern')
    case 'Agent':
      return str(e, 'description')
    case 'Workflow':
      return workflowName(str(e, 'script')) || str(e, 'name') || shortPath(str(e, 'scriptPath'))
    case 'WebFetch':
      return str(e, 'url').replace(/^https?:\/\//, '').slice(0, 60)
    case 'WebSearch':
    case 'ToolSearch':
      return str(e, 'query')
    case 'Skill':
      return str(e, 'skill')
    case 'StructuredOutput':
      return 'handing back its result'
    default:
      return ''
  }
}

export function toolLimit(e: Record<string, unknown>): number | null {
  if (String(e['tool']) !== 'Bash' || e['run_in_background'] === true) return null
  const timeout = e['timeout']
  return typeof timeout === 'number' && timeout > 0 ? timeout : BASH_LIMIT_MS
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  return `${Math.floor(s / 86_400)}d`
}

export function until(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function kb(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`
  return `${n} B`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += b === undefined ? '=' : B64.charAt((n >> 6) & 63)
    out += c === undefined ? '=' : B64.charAt(n & 63)
  }
  return out
}
