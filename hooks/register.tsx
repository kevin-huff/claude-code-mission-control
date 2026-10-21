import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Cursor, Prefs, ScrubProps } from '../types'
import type { El } from './art'
import * as D from './deck'
import { drawPane, replayRunOf } from './view'

const PANE = 'mission-control'
const OPEN = { id: PANE, title: 'Mission Control', columns: 84, rows: 40 }
const STATUS_CAPTURE = '/tmp/.claude-statusline-last.json'
const PREFS: Prefs = { showDone: true, autoOpen: true, autoEscalate: true }
const deckAtom = atom({ plugin: 'mission-control', key: 'deck' } as const, D.emptyDeck())
const prefsAtom = atom({ plugin: 'mission-control', key: 'prefs' } as const, PREFS)
const cursorAtom = atom({ plugin: 'mission-control', key: 'cursor' } as const, null as Cursor)

type Runtime = {
  store: D.Store
  timer: Timer | undefined
  beats: number
  busy: boolean
  wasLive: boolean
  autoOpened: boolean
  mirror: string | null
  journalBeats: number
  sessionId: string | null
  journalSizes: Map<string, number>
  journalGone: Set<string>
}

async function prefsOf($: EngineInterface): Promise<Prefs> {
  return { ...PREFS, ...(await read($, prefsAtom)) }
}

// Each flush also lands in /tmp/claude-<uid>/mission-control-<session>.json, inside the
// per-user Claude temp folder (mode 700, so only this account reads it), so scripts and other
// sessions of the same user can read what the pane shows. Where that folder can't be made or
// vouched for, no mirror is written.
async function mirrorPathOf($: EngineInterface, sessionId: string | null): Promise<string | null> {
  if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return null
  try {
    const uid = (await $.process.run(['id', '-u'])).stdout.trim()
    if (!/^\d+$/.test(uid)) return null
    const dir = `/tmp/claude-${uid}`
    const made = await $.process.run(['mkdir', '-p', '-m', '700', dir])
    if (made.exitCode !== 0) return null
    const seen = await $.process.run(['stat', '-c', '%u %a', dir])
    const [owner, mode] = seen.stdout.trim().split(' ')
    if (seen.exitCode !== 0 || owner !== uid || !/^[0-7]00$/.test(mode ?? '')) return null
    return `${dir}/mission-control-${sessionId}.json`
  } catch {
    return null
  }
}

async function flush($: EngineInterface, rt: Runtime, now: number) {
  rt.store.dirty = false
  const deck = D.snapshot(rt.store, now)
  await update($, deckAtom, () => deck)
  if (rt.mirror) await $.fs.write(rt.mirror, JSON.stringify(deck)).catch(() => undefined)
}

async function readJournals($: EngineInterface, rt: Runtime, now: number) {
  for (const run of rt.store.runs.values()) {
    if (!D.journalWanted(rt.store, run) || rt.journalGone.has(run.id)) continue
    const path = D.journalPath(run)
    if (!path) continue
    const live = run.endedAt === null
    try {
      const stat = await $.fs.stat(path)
      const size = stat.kind === 'file' ? stat.size : -1
      if (live && size === rt.journalSizes.get(run.id)) continue
      const text = await $.fs.read(path)
      D.absorbJournal(rt.store, run.id, text, now)
      rt.journalSizes.set(run.id, size)
    } catch {
      if (!live) rt.journalGone.add(run.id)
    }
  }
}

export function liveCursor(runs: { id: string }[], cursor: Cursor): Cursor {
  return cursor && runs.some(run => run.id === cursor.runId) ? cursor : null
}

async function moveCursor($: EngineInterface, dir: -1 | 1) {
  const deck = await read($, deckAtom)
  const cursor = liveCursor(deck.runs, await read($, cursorAtom))
  const run = replayRunOf(deck.runs, cursor)
  if (!run) return
  if (dir === 1 && !cursor) return
  const end = run.endedAt ?? deck.at
  const step = Math.max(10_000, Math.round((end - run.startedAt) / 40))
  const base = cursor?.at ?? end
  const at = Math.min(end, Math.max(run.startedAt, base + dir * step))
  const value: Cursor = dir === 1 && at >= end && run.endedAt === null ? null : { runId: run.id, at }
  await update($, cursorAtom, () => value)
}

async function goLive($: EngineInterface) {
  await update($, cursorAtom, () => null)
}

async function takeScrub($: EngineInterface, data: unknown) {
  if (typeof data !== 'object' || data === null) return
  const { runId, at } = data as { runId?: unknown; at?: unknown }
  if (typeof runId !== 'string' || !runId) return
  const deck = await read($, deckAtom)
  const run = deck.runs.find(r => r.id === runId)
  if (!run) return
  if (at === null) await update($, cursorAtom, () => null)
  else if (typeof at === 'number' && Number.isFinite(at)) {
    const clamped = Math.min(run.endedAt ?? deck.at, Math.max(run.startedAt, Math.round(at)))
    await update($, cursorAtom, () => ({ runId, at: clamped }))
  }
}

// A reviewer's verdict reaches the journal a moment after its agent ends, so the next few beats
// re-read the journal of a run that is still going.
function noteEnded(rt: Runtime, agentId: string | undefined) {
  const runId = agentId ? rt.store.agents.get(agentId)?.runId : null
  if (runId && rt.store.runs.get(runId)?.endedAt === null) rt.journalBeats = 3
}

async function reconcile($: EngineInterface, rt: Runtime, now: number) {
  for (const info of await $.agent.list()) {
    const row = rt.store.agents.get(info.id)
    if (!row || row.endedAt !== null) continue
    if (info.status === 'completed' || info.status === 'failed' || info.status === 'killed') {
      D.turnEnded(rt.store, info.id, info.status === 'completed' ? 'answer' : info.status === 'killed' ? 'aborted' : 'error', now)
      noteEnded(rt, info.id)
    }
  }
}

async function readStatus($: EngineInterface, rt: Runtime) {
  D.absorbStatus(rt.store, await $.fs.read(STATUS_CAPTURE), rt.sessionId)
}

async function beat($: EngineInterface, rt: Runtime) {
  if (rt.busy) return
  rt.busy = true
  try {
    rt.beats += 1
    const now = await $.clock.now()
    for (const text of D.tick(rt.store, now)) $.ui.toast(text, { timeoutMs: 8_000 })
    const draining = rt.journalBeats > 0
    if (draining) rt.journalBeats -= 1
    if (draining || rt.beats % 3 === 0) await readJournals($, rt, now).catch(() => undefined)
    if (rt.beats % 10 === 0) await reconcile($, rt, now).catch(() => undefined)
    if (rt.beats % 15 === 1) await readStatus($, rt).catch(() => undefined)
    const live = D.anyLive(rt.store)
    if (rt.store.dirty || live || rt.wasLive) await flush($, rt, now)
    rt.wasLive = live
  } catch {
    rt.store.dirty = true
  } finally {
    rt.busy = false
  }
}

async function noteWorkflow($: EngineInterface, rt: Runtime, toolUseId: string, fields: Record<string, unknown>) {
  let name = D.workflowName(typeof fields['script'] === 'string' ? fields['script'] : '')
  const path = fields['scriptPath']
  if (!name && typeof path === 'string') name = D.workflowName(await $.fs.read(path).catch(() => ''))
  rt.store.runNames.set(toolUseId, name || D.toolLabel(fields) || 'workflow')
  D.noteLimit(rt.store, toolUseId, fields['args'])
}

async function openAgent($: EngineInterface, agentId: string) {
  const moved = await $.ui.view({ agentId })
  if (moved.deny) $.ui.toast(`Mission Control can't show that agent here: ${moved.deny}`)
}

async function clearDone($: EngineInterface, rt: Runtime) {
  D.clearFinished(rt.store)
  await flush($, rt, await $.clock.now())
  const cursor = await read($, cursorAtom)
  if (cursor && !liveCursor((await read($, deckAtom)).runs, cursor)) await update($, cursorAtom, () => null)
}

async function toggleEscalate($: EngineInterface, rt: Runtime) {
  await update($, prefsAtom, prefs => ({ ...PREFS, ...prefs, autoEscalate: prefs.autoEscalate === false }))
  rt.store.autoEscalate = (await prefsOf($)).autoEscalate
  $.ui.toast(`Mission Control will ${rt.store.autoEscalate ? 'raise' : 'no longer raise'} a struggling subagent's effort`)
}

// Every hook here watches and passes the event on. The one change it makes: a subagent that
// keeps failing commands gets its next requests at a higher effort, when auto-raise is on.
export const register: Register = on => {
  const rt: Runtime = {
    store: D.createStore(),
    timer: undefined,
    beats: 0,
    busy: false,
    wasLive: false,
    autoOpened: false,
    mirror: null,
    journalBeats: 0,
    sessionId: null,
    journalSizes: new Map(),
    journalGone: new Set(),
  }
  const store = rt.store

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'mission-control',
      description: 'Open Mission Control: a live view of what every subagent and workflow agent is doing',
    })
    if (store.agents.size === 0) D.restore(store, await read($, deckAtom))
    store.autoEscalate = (await prefsOf($)).autoEscalate
    rt.sessionId = await $.session.id().then(
      id => id,
      () => null,
    )
    rt.mirror = await mirrorPathOf($, rt.sessionId)
    store.dirty = true
    rt.timer?.cancel()
    rt.timer = $.clock.every(1_000, () => void beat($, rt))
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      rt.timer?.cancel()
      rt.timer = undefined
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      try {
        D.spawned(
          store,
          {
            agentId: result.agentId,
            description: e.description,
            subagentType: e.subagentType,
            model: result.model ?? '',
            runId: e.workflow?.runId || null,
            index: e.workflow?.agentIndex ?? null,
            toolUseId: e.tool_use_id,
            isTeammate: e.isTeammate === true,
          },
          await $.clock.now(),
        )
        if (!rt.autoOpened) {
          rt.autoOpened = true
          if ((await prefsOf($)).autoOpen) void $.ui.open(OPEN).catch(() => undefined)
        }
      } catch {
        store.dirty = true
      }
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    D.turnStarted(store, e.agentId, await $.clock.now())
    return result
  })

  on('turn.step', async function* ($, e, next) {
    let mode = ''
    let raised: D.Level | undefined
    try {
      D.stepStarted(store, e.agentId, { effort: e.effort, model: e.model }, await $.clock.now())
      raised = D.effortToSend(store, e.agentId, e.effort)
    } catch {
      raised = undefined
    }
    for await (const chunk of next(raised ? { ...e, effort: raised } : e)) {
      try {
        if (chunk.kind === 'thinking' || chunk.kind === 'text') {
          if (mode !== chunk.kind) {
            mode = chunk.kind
            D.streamed(store, e.agentId, chunk.kind, await $.clock.now())
          }
        } else if (chunk.kind === 'tool') {
          mode = 'tool'
          D.composing(store, e.agentId, chunk.name, await $.clock.now())
        } else if (chunk.kind === 'input') {
          D.composed(store, e.agentId, chunk.json)
        } else if (chunk.kind === 'stop') {
          D.stepStopped(store, e.agentId, chunk.usage, await $.clock.now())
        }
      } catch {
        mode = ''
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    const fields = e as unknown as Record<string, unknown>
    let tracked = false
    try {
      const now = await $.clock.now()
      const transcript = fields['transcript_path']
      if (e.agentId === undefined && typeof transcript === 'string') store.transcriptDir = transcript.replace(/\.jsonl$/, '')
      if (String(e.tool) === 'Workflow') await noteWorkflow($, rt, e.tool_use_id, fields)
      D.toolStarted(
        store,
        e.agentId,
        { id: e.tool_use_id, tool: String(e.tool), label: D.toolLabel(fields), since: now, limitMs: D.toolLimit(fields) },
        now,
      )
      tracked = true
    } catch {
      tracked = false
    }
    const result = await next(e)
    if (tracked) {
      try {
        const denied = 'deny' in result && typeof result.deny === 'string' ? result.deny : ''
        const failed = Boolean(denied) || ('isError' in result && result.isError === true)
        const text = denied || ('text' in result && typeof result.text === 'string' ? result.text : '')
        const raised = D.toolEnded(store, e.agentId, e.tool_use_id, failed, await $.clock.now(), failed ? text : '')
        if (raised) $.ui.toast(`Mission Control: ${raised}`, { timeoutMs: 8_000 })
      } catch {
        store.dirty = true
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    D.turnEnded(store, e.agentId, e.reason, await $.clock.now())
    noteEnded(rt, e.agentId)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, prefsAtom, prefs => ({ ...PREFS, ...prefs, autoOpen: false }))
    return next(e)
  })

  on('command.run', { command: 'mission-control' }, async $ => {
    await update($, prefsAtom, prefs => ({ ...PREFS, ...prefs, autoOpen: true }))
    const opened = await $.ui.open(OPEN)
    return {
      text: opened.isPlaced
        ? 'Mission Control is open beside the chat.'
        : `Mission Control is open and waiting for room to draw: ${opened.reason}`,
    }
  })

  on('ui.message', { element: 'scrubber' }, async ($, e, next) => {
    await takeScrub($, e.data).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const deck = await read($, deckAtom)
    const prefs = await prefsOf($)
    const cursor = liveCursor(deck.runs, await read($, cursorAtom))
    const el = $.ui.resolve(e)
    const Client = (el as El)['Client']
    const scrubber = Client
      ? (p: ScrubProps) => <Client key="scrubber" module="./scrubber.tsx" props={p} width={p.cols} height={1} />
      : null
    return drawPane(el, {
      deck,
      prefs,
      width: e.props.bodyColumns,
      rows: e.props.scroll.bodyRows,
      surface: e.surface,
      viewing: e.props.view.agentId,
      cursor,
      scrubber,
      act: {
        open: (agentId: string) => openAgent($, agentId),
        main: () => $.ui.view({}),
        toggleDone: () => update($, prefsAtom, p => ({ ...PREFS, ...p, showDone: !p.showDone })),
        clearDone: () => clearDone($, rt),
        toggleEscalate: () => toggleEscalate($, rt),
        back: () => moveCursor($, -1),
        next: () => moveCursor($, 1),
        live: () => goLive($),
      },
    })
  })
}
