// What an agent is doing, one letter each: waiting for the model's first word, thinking,
// writing a tool call's arguments (a file, a script), writing visible text, running a tool,
// running a tool for over a minute, stuck (near its time limit, or thinking for minutes),
// idle between turns.
export type Code = 'q' | 't' | 'w' | 'x' | 'b' | 'l' | 's' | 'i'

export type ToolRun = {
  id: string
  tool: string
  label: string
  since: number
  limitMs: number | null
}

export type Compose = {
  tool: string
  target: string
  bytes: number
}

// One letter per bucket of `size` ms from `origin`; buckets double in size past a cap.
export type Timeline = {
  origin: number
  size: number
  codes: string
}

export type Recent = {
  tool: string
  label: string
  ok: boolean
  ms: number
}

export type AgentRow = {
  id: string
  label: string
  type: string
  runId: string | null
  index: number
  model: string | null
  effort: string | null
  baseEffort: string | null
  bumps: number
  fails: number
  startedAt: number
  endedAt: number | null
  outcome: 'done' | 'failed' | 'stopped' | null
  code: Code
  since: number
  step: number
  stepSince: number | null
  compose: Compose | null
  tools: ToolRun[]
  toolCalls: number
  errors: number
  ctx: number
  window: number
  out: number
  lastRate: number
  note: string
  recent: Recent[]
  tl: Timeline
}

export type RunRow = {
  id: string
  name: string
  dir: string | null
  startedAt: number
  endedAt: number | null
  phases: Record<string, string>
  plan: PlanTicket[] | null
  // The planner's own tickets, kept when the critic's plan replaces plan
  draft: PlanTicket[] | null
  planFrom: 'planner' | 'critic' | null
  verdicts: Record<string, Verdict>
  final: FinalVerdict | null
  // Each final review's own verdict, by its agent id, so every round and every replayed moment shows the
  // verdict that review gave (or none, when it gave none)
  finals: Record<string, FinalVerdict>
  limitBase: Limit | null
  // The workflow's maxTickets argument; null means its default of 16
  maxTickets: number | null
}

// One ticket as the planner, critic or a fix plan wrote it. `from` is the fix plan agent that supplied it (absent for
// planner and critic tickets); `dropped` marks a ticket past the ticket limit, kept only so later F numbers line up.
export type PlanTicket = { id: string; title: string; kind: string; dependsOn: string[]; estimateMin: number | null; from?: string; dropped?: boolean }

// A ticket reviewer's verdict: summary at most 140 chars, issue the first issue (at most 160 chars) or ''
export type Verdict = { pass: boolean; summary: string; issue: string }

// The final review's verdict ('ship', 'fix first' or 'block') and its summary
export type FinalVerdict = { verdict: string; summary: string }

export type FeedKind = 'start' | 'done' | 'fail' | 'up' | 'guard' | 'warn' | 'run'

export type FeedItem = {
  at: number
  kind: FeedKind
  text: string
}

// [minute since the epoch, output tokens in it, most agents live at once in it]
export type Minute = [number, number, number]

export type Limit = {
  pct: number
  resetsAt: number
}

export type Usage = {
  fiveHour: Limit | null
  sevenDay: Limit | null
  costUsd: number | null
  ctxPct: number | null
}

export type Guards = {
  search: number
  effort: number
  disk: number
}

export type Deck = {
  at: number
  main: AgentRow | null
  agents: AgentRow[]
  runs: RunRow[]
  transcriptDir: string | null
  feed: FeedItem[]
  minutes: Minute[]
  usage: Usage | null
  guards: Guards
}

export type Prefs = {
  showDone: boolean
  autoOpen: boolean
  autoEscalate: boolean
}

// Where the replay sits: null means the pane follows the run live
export type Cursor = { runId: string; at: number } | null

// What the scrubber surface is given: the run, its width in columns, its time span, now and the cursor
export type ScrubProps = { runId: string; cols: number; from: number; to: number; now: number; at: number | null }

// Where a ticket's lane stands
export type LaneStatus = 'waiting' | 'ready' | 'building' | 'reviewing' | 'passed' | 'failed' | 'skipped'

// One build and review try on a ticket, with the tier it ran at and the verdict it got
export type Attempt = { n: number; tier: string; rung: number; build: AgentRow | null; review: AgentRow | null; verdict: Verdict | null }

// One ticket's lane: its plan entry, status, attempts and live agent as of a moment
export type Lane = { id: string; title: string; kind: string; dependsOn: string[]; estimateMin: number; status: LaneStatus; attempts: Attempt[]; maxAttempts: number; startedAt: number | null; endedAt: number | null; tokens: number; live: AgentRow | null }

// Which part of a sprint the run is in
export type SprintStage = 'deciding' | 'building' | 'integrating' | 'reviewing' | 'done'

// A run understood as a sprint, as of the moment `at`; round is 0 for the first round, k once fix round k has started
export type Sprint = { runId: string; name: string; startedAt: number; endedAt: number | null; at: number; round: number; stage: SprintStage; draft: boolean; lanes: Lane[]; deciders: AgentRow[]; closers: AgentRow[]; final: FinalVerdict | null
  // Output tokens of every agent of the run started by at (planner, critic, fix plans, lanes, integrate, final reviews), scaled to at
  tokens: number
  // The merged final verdict of round - 1; null in round 0
  previous: FinalVerdict | null }

// When one ticket is projected to start and finish, and how much it could slip without delaying the end
export type Projection = { id: string; start: number; finish: number; slackMs: number; critical: boolean; after: string | null }

// The forecast for a sprint: projections, critical path, what the run waits on, and the finish estimate
export type Forecast = { at: number; factor: number; projections: Record<string, Projection>; criticalPath: string[]; longPole: string | null; waiting: { on: string; blocked: string[] }[]; buildEnd: number | null; eta: number | null }

declare module 'claude-code' {
  interface PluginState {
    'mission-control': { deck: Deck; prefs: Prefs; cursor: Cursor }
  }
}
