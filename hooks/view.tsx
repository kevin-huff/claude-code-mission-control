import type { Cursor, Deck, Prefs, RunRow, ScrubProps } from '../types'
import type { El } from './art'
import { banner, hex, paint } from './art'
import * as D from './deck'
import { P, compact, rule } from './look'
import { tiles, gauges, activity, card, agentLine, runSection, throughput, feed, timeShare, legend } from './sections'
import { flightColumns, flightPlan, flightSpan } from './flight'
import { burn, headline } from './headline'
import { heroStatus, heroTiles, laneRowIds, pickHero, sprintViews, viewAt } from './hero'
import { skyMap } from './sky'
import { parseLabel } from './sprint'

const LOOSE_WINDOW_MS = 30 * 60_000

export type Actions = {
  open: (agentId: string) => unknown
  main: () => unknown
  toggleDone: () => unknown
  clearDone: () => unknown
  toggleEscalate: () => unknown
  back: () => unknown
  next: () => unknown
  live: () => unknown
}

export type DrawArgs = {
  deck: Deck
  prefs: Prefs
  width: number
  rows: number
  surface: string
  viewing: string | undefined
  cursor: Cursor
  scrubber: ((p: ScrubProps) => unknown) | null
  act: Actions
}

export function replayRunOf(runs: RunRow[], cursor: Cursor): RunRow | null {
  const own = cursor ? runs.find(run => run.id === cursor.runId) : undefined
  if (own) return own
  return [...runs].filter(run => run.plan !== null).sort((x, y) => y.startedAt - x.startedAt)[0] ?? null
}

type Axis = { from: number; to: number; cols: number; indent: number }

function scrubSlot(el: El, a: DrawArgs, run: RunRow, width: number, now: number, axis?: Axis) {
  const { Box } = el
  const at = a.cursor && a.cursor.runId === run.id ? a.cursor.at : null
  const p: ScrubProps = axis
    ? { runId: run.id, cols: axis.cols, from: axis.from, to: axis.to, now, at }
    : { runId: run.id, cols: width, from: run.startedAt, to: run.endedAt ?? now, now, at }
  return (
    <Box key="scrub-slot" flexDirection="column" paddingLeft={axis?.indent ?? 0}>
      {a.scrubber ? a.scrubber(p) : ''}
    </Box>
  )
}

function stripAxis(span: [number, number], width: number): Axis | undefined {
  const cols = flightColumns(width)
  return cols.strip > 0 ? { from: span[0], to: span[1], cols: cols.strip, indent: 2 + cols.idW + cols.titleW + 1 + cols.pipsW } : undefined
}

export function drawPane(el: El, a: DrawArgs) {
  const { Box, Text, Button } = el
  const { deck, prefs, act } = a
  const now = deck.at || 0
  const width = Math.max(30, a.width)
  const terminal = a.surface === 'terminal'
  const agents = deck.agents
  const liveAgents = agents.filter(D.isLive)
  const liveRows = [...(deck.main && D.isLive(deck.main) ? [deck.main] : []), ...liveAgents]
  const stuck = liveAgents.filter(row => D.displayCode(row, now) === 's').length
  const done = agents.filter(row => row.endedAt !== null).length
  const raised = agents.reduce((n, row) => n + row.bumps, 0)
  const s = D.shares(agents)
  const nowMin = Math.floor(now / 60_000)
  const perMin = Math.max(...deck.minutes.filter(([m]) => m >= nowMin - 1).map(([, t]) => t), 0)
  const replayRun = replayRunOf(deck.runs, a.cursor)
  const views = sprintViews(deck, a.cursor)
  const hero = pickHero(views)
  const heroRows = hero ? agents.filter(row => row.runId === hero.run.id) : []
  const heroLive = hero && hero.replaying ? viewAt(hero.run, heroRows, null, now) : hero
  const laneIds = heroLive ? laneRowIds(heroLive) : new Set<string>()
  const parts = []
  let used = 0

  const buttons = (
    <Box key="buttons" flexDirection="row" flexWrap="wrap" gap={1}>
      {a.viewing ? [<Button key="main" hotkey="m" label="◂ main" onPress={act.main} />] : []}
      <Button key="done" hotkey="f" label={prefs.showDone ? 'hide done' : 'show done'} onPress={act.toggleDone} />
      <Button key="clear" hotkey="c" label="clear done" onPress={act.clearDone} />
      <Button key="raise" hotkey="e" label={`auto-raise ${prefs.autoEscalate ? 'on' : 'off'}`} onPress={act.toggleEscalate} />
      {replayRun
        ? [
            <Button key="back" hotkey="b" label="◂ back" onPress={act.back} />,
            <Button key="next" hotkey="n" label="fwd ▸" onPress={act.next} />,
          ]
        : []}
      <Button key="live" hotkey="l" label="live" dimColor={!a.cursor} onPress={act.live} />
    </Box>
  )

  const status = hero ? heroStatus(hero) : liveAgents.length ? `● ${liveAgents.length} live` : done ? `✓ ${done} done` : '○ standing by'
  const short = a.rows < 30
  if (!short) {
    parts.push(paint(el, banner(width, now, 'MISSION CONTROL', 'agents · effort · time', status, hex(liveAgents.length ? P.green : P.over1)), 'banner', terminal))
    used += 3
  }
  parts.push(buttons)
  used += 2
  if (hero) {
    parts.push(<Text mono color={P.text} wrap="truncate-end">{headline(hero.s, hero.f)}</Text>)
    used += 1
    const b = heroLive && heroLive.s.endedAt === null ? burn(heroLive.run, deck.usage, heroLive.f, heroLive.at) : null
    if (b) {
      parts.push(<Text mono color={b.level === 'over' ? P.red : b.level === 'warn' ? P.yellow : P.over1} wrap="truncate-end">{b.text}</Text>)
      used += 1
    }
  }
  const replayDrawn = views.some(v => v.replaying && (prefs.showDone || v.run.endedAt === null))
  if (a.cursor && replayRun && !hero?.replaying && !replayDrawn) {
    const end = replayRun.endedAt ?? now
    parts.push(<Text mono color={P.yellow}>{`REPLAY ${D.clock(a.cursor.at - replayRun.startedAt)} of ${D.clock(end - replayRun.startedAt)} · l goes back to live`}</Text>)
    used += 1
  }

  const tileCount = short ? 0 : width >= 96 ? 6 : width >= 80 ? 5 : width >= 64 ? 4 : width >= 48 ? 3 : 0
  const tileItems = (hero && (hero.replaying || hero.s.stage !== 'deciding') ? heroTiles(hero) : [
    { label: 'LIVE', value: String(liveAgents.length), color: liveAgents.length ? P.green : P.over0 },
    { label: 'DONE', value: String(done), color: P.blue },
    { label: 'TOKENS/MIN', value: compact(perMin), color: P.mauve },
    { label: 'TIME THINKING', value: `${s?.think ?? 0}%`, color: P.pink },
    { label: 'STUCK', value: String(stuck), color: stuck ? P.red : P.over0 },
    { label: 'RAISED', value: String(raised), color: raised ? P.peach : P.over0 },
  ]).slice(0, tileCount)
  if (tileItems.length) {
    parts.push(tiles(el, tileItems, width, terminal))
    used += 6
  }
  const gaugeLines = gauges(el, deck, agents, width, now, terminal)
  parts.push(
    <Box key="gauges" flexDirection="column">
      {gaugeLines}
    </Box>,
  )
  used += gaugeLines.length

  if (hero) {
    const { s, f } = hero
    const steadyS = hero.replaying && heroLive ? heroLive.s : undefined
    const map = skyMap(el, s, f, { width, terminal, steady: steadyS })
    if (map) {
      parts.push(map)
      used += Math.min(8, Math.max(3, (steadyS ?? s).lanes.length)) + 1
    }
    const span = hero.replaying && heroLive ? flightSpan(heroLive.s, heroLive.f) : flightSpan(s, f)
    parts.push(flightPlan(el, s, f, { width, terminal, replay: hero.replaying, span, steady: steadyS }))
    used += Math.max(s.lanes.length, steadyS?.lanes.length ?? 0) + 5
    if (a.scrubber) {
      parts.push(scrubSlot(el, a, hero.run, width, now, stripAxis(span, width)))
      used += 3
    }
    if (s.endedAt === null && !hero.replaying) {
      const working = s.lanes.filter(lane => lane.live !== null)
      if (working.length) {
        parts.push(rule(el, width, 'WORKING', `${working.length} ${working.length === 1 ? 'lane' : 'lanes'}`))
        used += 1
        for (const lane of working) {
          const row = lane.live
          if (!row) continue
          const p = parseLabel(row.label)
          const who = p ? `${p.id} ${p.role}${p.n !== null && p.of !== null ? ` ${p.n}/${p.of}` : ''}` : lane.id
          const doing = activity(row, D.displayCode(row, now), now)
          parts.push(
            <Text mono wrap="truncate-end">
              <Text mono color={P.sub0}>{`   ${who} `}</Text>
              <Text mono color={doing.color}>{doing.text}</Text>
            </Text>,
          )
          used += 1
        }
      }
    }
  }

  const cardRows = liveRows.filter(row => !laneIds.has(row.id))
  const density = cardRows.length <= 3 ? 4 : cardRows.length <= 6 ? 3 : 2
  parts.push(rule(el, width, 'NOW', liveRows.length ? `${liveRows.length} live${hero?.replaying ? ' now' : ''}${stuck ? ` · ${stuck} stuck` : ''}` : 'nothing running'))
  used += 1
  if (!liveRows.length) {
    parts.push(<Text mono color={P.over0}>{agents.length ? '   All quiet. Finished runs are below.' : '   Agents and workflow runs show up here the moment they start.'}</Text>)
    used += 1
  } else if (hero?.replaying) {
    parts.push(<Text mono color={P.over0}>{'   Live agents are hidden while replaying · l goes back to live.'}</Text>)
    used += 1
  } else if (!cardRows.length) {
    parts.push(<Text mono color={P.over0}>{'   Every live agent is working a sprint ticket, shown above.'}</Text>)
    used += 1
  }
  const ordered = hero?.replaying ? [] : [...cardRows].sort((x, y) => Number(D.displayCode(y, now) === 's') - Number(D.displayCode(x, now) === 's') || x.startedAt - y.startedAt)
  for (const row of ordered) {
    parts.push(card(el, row, now, width, density, a.viewing, act, terminal))
    used += density - (density >= 4 && !row.recent.length ? 1 : 0)
  }

  for (const run of [...deck.runs].sort((x, y) => y.startedAt - x.startedAt)) {
    if (hero && run.id === hero.run.id) continue
    const mine = agents.filter(row => row.runId === run.id)
    if (!mine.length) continue
    if (run.endedAt !== null && !prefs.showDone) {
      parts.push(<Text mono color={P.over0}>{`   ✓ ${run.name} · ${D.clock(run.endedAt - run.startedAt)} · ${mine.length} agents (hidden)`}</Text>)
      used += 1
      continue
    }
    const view = views.find(v => v.run.id === run.id)
    if (view) {
      // Every flight plan keys its Raster 'flight-strips' and a tree may draw that key once, so only the lead sprint's
      // plan gets one; the others paint the same cells as colored text.
      // A replayed run keeps the axis of its un-replayed view, so the strip does not re-scale as the cursor moves.
      const steady = view.replaying ? viewAt(run, mine, null, now) : view
      const span = steady ? flightSpan(steady.s, steady.f) : flightSpan(view.s, view.f)
      parts.push(flightPlan(el, view.s, view.f, { width, terminal: false, replay: view.replaying, span, steady: view.replaying && steady ? steady.s : undefined }))
      used += Math.max(view.s.lanes.length, view.replaying && steady ? steady.s.lanes.length : 0) + 5
      if (!hero && a.scrubber && replayRun && run.id === replayRun.id) {
        parts.push(scrubSlot(el, a, run, width, now, stripAxis(span, width)))
        used += 3
      }
      continue
    }
    parts.push(runSection(el, run, mine, now, width, terminal))
    used += 2 + mine.length
  }
  const loose = agents.filter(row => row.runId === null && (row.endedAt === null ? D.isLive(row) : prefs.showDone && row.endedAt >= now - LOOSE_WINDOW_MS))
  if (loose.length) {
    const from = Math.max(now - LOOSE_WINDOW_MS, Math.min(...loose.map(row => row.startedAt)))
    parts.push(
      <Box key="loose" flexDirection="column">
        {rule(el, width, 'SUBAGENTS', 'last 30 min')}
        {[...loose].sort((x, y) => x.startedAt - y.startedAt).map(row => agentLine(el, row, from, now, now, width, terminal))}
      </Box>,
    )
    used += 1 + loose.length
  }

  const thru = throughput(el, deck, now, width, terminal)
  if (thru) {
    parts.push(thru)
    used += 4
  }
  const tail = timeShare(el, s, width, terminal)
  const tailRows = (tail ? 3 : 0) + 2
  const feedCount = Math.max(4, Math.min(16, a.rows - used - tailRows - 1))
  parts.push(feed(el, deck.feed, now, width, feedCount))
  if (tail) parts.push(tail)
  parts.push(legend(el))
  return <Box flexDirection="column">{parts}</Box>
}
