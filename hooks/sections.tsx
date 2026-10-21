import type { AgentRow, Code, Deck, FeedItem, Limit, RunRow } from '../types'
import type { El } from './art'
import { along, bigText, bigWidth, hex, meter, paint, spark, stacked } from './art'
import type { Shares } from './deck'
import * as D from './deck'
import { P, STATE, GLYPH, WORD, LEGEND, SHORT, EFFORT_HEX, FEED_LOOK, fit, len, compact, tierOf, effortHex, rule, mark, strip } from './look'

export type CardActions = { open: (agentId: string) => unknown; main: () => unknown }

export function tiles(el: El, items: { label: string; value: string; color: string }[], width: number, terminal: boolean) {
  const { Box, Text } = el
  const outer = Math.floor((width - (items.length - 1)) / items.length)
  const inner = Math.max(4, outer - 2)
  return (
    <Box key="tiles" flexDirection="row" gap={1}>
      {items.map((t, i) => (
        <Box key={`tile-${i}`} flexDirection="column" alignItems="center" borderStyle="round" borderColor={t.color} width={outer}>
          {bigWidth(t.value) <= inner
            ? paint(el, bigText(t.value, hex(t.color)), `big-${i}`, terminal)
            : <Text mono color={t.color} weight="bold">{fit(t.value, inner)}</Text>}
          <Text mono color={P.over1}>{fit(t.label, Math.min(inner, len(t.label)))}</Text>
        </Box>
      ))}
    </Box>
  )
}

function limitHex(pct: number): string {
  return pct < 50 ? P.green : pct < 80 ? P.yellow : P.red
}

function limitGauge(el: El, key: string, label: string, limit: Limit | null, cols: number, now: number, terminal: boolean) {
  const { Box, Text } = el
  if (!limit) return null
  const color = limitHex(limit.pct)
  const resets = limit.resetsAt > now ? ` · resets ${D.until(limit.resetsAt - now)}` : ''
  return (
    <Box key={key} flexDirection="row">
      <Text mono color={P.over1}>{`${label} `}</Text>
      {paint(el, meter(cols, limit.pct / 100, hex(color)), `${key}-bar`, terminal)}
      <Text mono color={color}>{` ${Math.round(limit.pct)}%`}</Text>
      <Text mono color={P.over0}>{resets}</Text>
    </Box>
  )
}

export function gauges(el: El, deck: Deck, rows: AgentRow[], width: number, now: number, terminal: boolean) {
  const { Box, Text } = el
  const out = []
  const u = deck.usage
  const bar = Math.max(8, Math.min(24, Math.floor(width * 0.2)))
  if (u && (u.fiveHour || u.sevenDay)) {
    const five = limitGauge(el, 'g5', '5h', u.fiveHour, bar, now, terminal)
    const seven = limitGauge(el, 'g7', '7d', u.sevenDay, bar, now, terminal)
    if (width >= 76) {
      out.push(
        <Box key="limits" flexDirection="row" gap={3}>
          {five ? [five] : []}
          {seven ? [seven] : []}
        </Box>,
      )
    } else {
      if (five) out.push(five)
      if (seven) out.push(seven)
    }
  }
  const efforts = new Map<string, number>()
  const models = new Map<string, number>()
  let raised = 0
  for (const row of rows) {
    if (row.effort) efforts.set(row.effort, (efforts.get(row.effort) ?? 0) + 1)
    const m = D.modelShort(row.model)
    if (m) models.set(m, (models.get(m) ?? 0) + 1)
    raised += row.bumps
  }
  if (efforts.size) {
    const order = D.LADDER.filter(level => efforts.has(level))
    const parts = order.map(level => ({ value: efforts.get(level) ?? 0, color: hex(EFFORT_HEX[level] ?? P.sub0) }))
    out.push(
      <Box key="effort" flexDirection="row">
        <Text mono color={P.over1}>effort </Text>
        {paint(el, stacked(bar, parts), 'effort-bar', terminal)}
        <Text mono> </Text>
        <Text mono wrap="truncate-end">
          {order.map(level => <Text mono color={EFFORT_HEX[level] ?? P.sub0}>{`${SHORT[level] ?? level} ${efforts.get(level)}  `}</Text>)}
          <Text mono color={P.over0}>{[...models.entries()].map(([m, n]) => `${m} ${n}`).join(' · ')}</Text>
          {raised ? <Text mono color={P.peach}>{`  ↑${raised} raised`}</Text> : ''}
        </Text>
      </Box>,
    )
  }
  const g = deck.guards
  const fired = g.search + g.effort + g.disk > 0
  const session = [u?.costUsd != null ? `$${u.costUsd.toFixed(2)}` : '', u?.ctxPct != null ? `context ${Math.round(u.ctxPct)}%` : ''].filter(Boolean).join(' · ')
  if (fired || session) {
    out.push(
      <Text mono wrap="truncate-end">
        {fired ? <Text mono color={P.over1}>guards </Text> : ''}
        {fired ? <Text mono color={P.yellow}>{`⊘ search ${g.search} · effort ${g.effort} · disk ${g.disk}`}</Text> : ''}
        {session ? <Text mono color={P.over0}>{`${fired ? '   ' : ''}this chat ${session}`}</Text> : ''}
      </Text>,
    )
  }
  return out
}

export function activity(row: AgentRow, code: Code, now: number): { text: string; color: string; limit: number | null; ran: number } {
  const tool = D.oldestTool(row)
  if (tool) {
    const ran = now - tool.since
    const more = row.tools.length > 1 ? ` +${row.tools.length - 1}` : ''
    return {
      text: `${GLYPH[code]} ${tool.tool}${tool.label ? ` · ${tool.label}` : ''}${more}`,
      color: STATE[code],
      limit: tool.limitMs,
      ran,
    }
  }
  const step = row.step ? ` · step ${row.step}` : ''
  const so = ` · ${D.clock(now - row.since)}`
  switch (code) {
    case 'w': {
      const c = row.compose
      const verb = c && D.isWriter(c.tool) ? 'writing' : `composing ${c?.tool ?? 'a call'}`
      return { text: `✎ ${verb}${c?.target ? ` ${c.target}` : ''} · ${D.kb(c?.bytes ?? 0)}`, color: STATE.w, limit: null, ran: 0 }
    }
    case 't':
      return { text: `✻ thinking${step}${so}`, color: STATE.t, limit: null, ran: 0 }
    case 's':
      return { text: `! thinking for ${D.clock(now - row.since)} with nothing written yet`, color: STATE.s, limit: null, ran: 0 }
    case 'x':
      return { text: `❯ writing its answer${step}`, color: STATE.x, limit: null, ran: 0 }
    case 'q':
      return { text: row.step ? `· waiting for the model${step}` : '· starting up', color: STATE.q, limit: null, ran: 0 }
    default:
      return { text: row.id === D.MAIN ? '◦ waiting for you' : '◦ idle, waiting on background work or a message', color: STATE.i, limit: null, ran: 0 }
  }
}

export function card(el: El, row: AgentRow, now: number, width: number, density: number, viewing: string | undefined, act: CardActions, terminal: boolean) {
  const { Box, Text, Button } = el
  const code = D.displayCode(row, now)
  const tool = D.oldestTool(row)
  const since = tool ? tool.since : row.since
  const inView = viewing === row.id || (viewing === undefined && row.id === D.MAIN)
  const labelW = Math.max(12, Math.min(30, width - 46))
  const state = `${GLYPH[code]} ${WORD[code]} ${D.clock(now - since)}`
  const used = 2 + labelW + 1 + 12 + 1 + len(state)
  const rateText = row.lastRate ? `${row.lastRate} tokens/s` : ''
  const rate = rateText && used + 1 + len(rateText) <= width ? rateText : ''
  const press = () => (row.id === D.MAIN ? act.main() : act.open(row.id))
  const a = activity(row, code, now)
  const lines = [
    <Button key={`open-${row.id}`} plain onPress={press}>
      <Text mono color={STATE[code]}>{inView ? '▶ ' : '▌ '}</Text>
      <Text mono color={P.text} weight="bold">{fit(row.label, labelW)}</Text>
      <Text mono color={effortHex(row)}>{` ${fit(tierOf(row), 12)}`}</Text>
      <Text mono color={STATE[code]}>{` ${state}`}</Text>
      <Text mono color={P.over0}>{rate ? `${' '.repeat(Math.max(1, width - used - len(rate)))}${rate}` : ''}</Text>
    </Button>,
  ]
  if (density >= 3) {
    const fill = row.window ? Math.min(1, row.ctx / row.window) : 0
    const fillHex = fill < 0.6 ? P.teal : fill < 0.85 ? P.yellow : P.red
    const prefix = '   context '
    const meterW = Math.max(4, Math.min(10, width - len(prefix) - 24))
    const detailW = Math.max(0, width - len(prefix) - meterW)
    const head = ` ${Math.round(fill * 100)}% ${D.tokens(row.ctx)} · step ${row.step} · ${row.toolCalls} commands · `
    const errs = `${row.errors} errors`
    const cut = fit(`${head}${errs} · ${D.tokens(row.out)} tokens out`, detailW)
    const pre = cut.slice(0, head.length)
    const mid = cut.slice(head.length, head.length + errs.length)
    const post = cut.slice(head.length + errs.length)
    lines.push(
      <Box key={`ctx-${row.id}`} flexDirection="row">
        <Text mono color={P.over0}>{prefix}</Text>
        {paint(el, meter(meterW, fill, hex(fillHex)), `ctxbar-${row.id}`, terminal)}
        <Text mono color={P.over0}>{pre}</Text>
        <Text mono color={row.errors ? P.red : P.over0}>{mid}</Text>
        <Text mono color={P.over0}>{post}</Text>
      </Box>,
    )
  }
  if (a.limit !== null) {
    const share = a.ran / a.limit
    lines.push(
      <Box key={`act-${row.id}`} flexDirection="row">
        <Text mono color={a.color} wrap="truncate-end">{`   ${fit(a.text, Math.max(10, width - 30))} `}</Text>
        {paint(el, meter(12, share, hex(share < 0.5 ? P.blue : share < 0.85 ? P.yellow : P.red)), `limit-${row.id}`, terminal)}
        <Text mono color={P.over0}>{` ${D.clock(a.ran)} / ${D.clock(a.limit)}`}</Text>
      </Box>,
    )
  } else {
    lines.push(<Text mono color={a.color} wrap="truncate-end">{`   ${a.text}${tool ? ` · ${D.clock(a.ran)}` : ''}`}</Text>)
  }
  if (density >= 4 && row.recent.length) {
    lines.push(
      <Text mono wrap="truncate-end">
        <Text mono color={P.over0}>{'   recent '}</Text>
        {[...row.recent].reverse().map(r => (
          <Text mono>
            <Text mono color={r.ok ? P.green : P.red}>{r.ok ? '✓' : '✗'}</Text>
            <Text mono color={P.over1}>{` ${r.tool}${r.label ? ` ${fit(r.label, 18).trimEnd()}` : ''} ${D.clock(r.ms)}  `}</Text>
          </Text>
        ))}
      </Text>,
    )
  }
  return (
    <Box key={`card-${row.id}`} flexDirection="column">
      {lines}
    </Box>
  )
}

export function agentLine(el: El, row: AgentRow, from: number, to: number, now: number, width: number, terminal: boolean) {
  const { Box, Text } = el
  const labelW = Math.max(10, Math.min(26, Math.floor(width * 0.26)))
  const stripW = Math.max(0, width - labelW - 23)
  const [glyph, glyphHex] = mark(row, now)
  const took = D.clock((row.endedAt ?? now) - row.startedAt)
  return (
    <Box key={`row-${row.id}`} flexDirection="row">
      <Text mono color={glyphHex}>{glyph}</Text>
      <Text mono color={row.endedAt !== null ? P.sub0 : P.text}>{` ${fit(row.label, labelW)}`}</Text>
      <Text mono color={effortHex(row)}>{` ${fit(tierOf(row), 11)} `}</Text>
      {stripW > 0 ? [strip(el, `strip-${row.id}`, D.cells(row, from, to, stripW, now), terminal)] : []}
      <Text mono color={P.over0}>{` ${took.padStart(7)}`}</Text>
    </Box>
  )
}

export function pipelineLine(el: El, run: RunRow, rows: AgentRow[], width: number) {
  const { Text } = el
  const order: string[] = []
  const byPhase = new Map<string, AgentRow[]>()
  for (const row of [...rows].sort((a, b) => a.index - b.index || a.startedAt - b.startedAt)) {
    const phase = run.phases[row.id]
    if (!phase) continue
    const list = byPhase.get(phase)
    if (list) list.push(row)
    else {
      byPhase.set(phase, [row])
      order.push(phase)
    }
  }
  if (!order.length) return null
  const parts = order.map(phase => {
    const list = byPhase.get(phase) ?? []
    const done = list.filter(row => row.endedAt !== null).length
    const live = list.some(D.isLive)
    const all = done === list.length
    return { phase, text: all ? `${phase} ✓` : `${phase} ${done}/${list.length}`, color: all ? P.green : live ? P.blue : P.over0, bold: live }
  })
  return (
    <Text mono wrap="truncate-end">
      {parts.map((p, i) => (
        <Text mono>
          {i ? <Text mono color={P.surf2}>{' ─▶ '}</Text> : <Text mono color={P.surf2}>{'  '}</Text>}
          <Text mono color={p.color} weight={p.bold ? 'bold' : 'regular'}>{p.text}</Text>
        </Text>
      ))}
    </Text>
  )
}

export function runSection(el: El, run: RunRow, rows: AgentRow[], now: number, width: number, terminal: boolean) {
  const { Box } = el
  const from = run.startedAt
  const to = run.endedAt ?? now
  const live = rows.filter(D.isLive).length
  const done = rows.filter(row => row.outcome === 'done').length
  const failed = rows.filter(row => row.outcome === 'failed' || row.outcome === 'stopped').length
  const info = [run.name, D.clock(to - from), live ? `${live} live` : '', done ? `${done} done` : '', failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(' · ')
  const sorted = [...rows].sort((a, b) => a.index - b.index || a.startedAt - b.startedAt)
  const body = sorted.map(row => agentLine(el, row, from, to, now, width, terminal))
  const pipe = pipelineLine(el, run, rows, width)
  return (
    <Box key={`run-${run.id}`} flexDirection="column">
      {rule(el, width, 'RUN', info)}
      {pipe ? [pipe] : []}
      {body}
    </Box>
  )
}

export function throughput(el: El, deck: Deck, now: number, width: number, terminal: boolean) {
  const { Box, Text } = el
  const nowMin = Math.floor(now / 60_000)
  const byMin = new Map(deck.minutes.map(([m, t, l]) => [m, [t, l] as const]))
  const tokensSeries: number[] = []
  const liveSeries: number[] = []
  for (let m = nowMin - 29; m <= nowMin; m++) {
    const slot = byMin.get(m)
    tokensSeries.push(slot?.[0] ?? 0)
    liveSeries.push(slot?.[1] ?? 0)
  }
  if (!tokensSeries.some(v => v > 0) && !liveSeries.some(v => v > 0)) return null
  const cols = Math.max(10, width - 29)
  const peak = Math.max(...tokensSeries)
  const current = Math.max(tokensSeries[tokensSeries.length - 1] ?? 0, tokensSeries[tokensSeries.length - 2] ?? 0)
  const stops = [hex(P.blue), hex(P.mauve), hex(P.pink)]
  return (
    <Box key="throughput" flexDirection="column">
      {rule(el, width, 'THROUGHPUT', 'last 30 min')}
      <Box flexDirection="row">
        <Text mono color={P.over1}>{'tokens/min  '}</Text>
        {paint(el, spark(cols, 2, tokensSeries, (v, max) => along(stops, v / max)), 'spark-out', terminal)}
        <Box flexDirection="column">
          <Text mono color={P.mauve}>{` ${compact(current)}/min`}</Text>
          <Text mono color={P.over0}>{` peak ${compact(peak)}`}</Text>
        </Box>
      </Box>
      <Box flexDirection="row">
        <Text mono color={P.over1}>{'live        '}</Text>
        {paint(el, spark(cols, 1, liveSeries, () => hex(P.teal)), 'spark-live', terminal)}
        <Text mono color={P.teal}>{` ${liveSeries[liveSeries.length - 1] ?? 0} now · peak ${Math.max(...liveSeries)}`}</Text>
      </Box>
    </Box>
  )
}

export function feed(el: El, items: FeedItem[], now: number, width: number, count: number) {
  const { Box, Text } = el
  const shown = items.slice(-count).reverse()
  return (
    <Box key="feed" flexDirection="column">
      {rule(el, width, 'FEED', shown.length ? `${items.length} events` : 'nothing yet')}
      {shown.map(item => {
        const [glyph, color] = FEED_LOOK[item.kind]
        return (
          <Text mono wrap="truncate-end">
            <Text mono color={P.over0}>{`${D.ago(now - item.at).padStart(5)}  `}</Text>
            <Text mono color={color}>{`${glyph} `}</Text>
            <Text mono color={item.kind === 'warn' || item.kind === 'fail' ? color : P.sub0}>{item.text}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

export function timeShare(el: El, s: Shares | null, width: number, terminal: boolean) {
  const { Box, Text } = el
  if (!s) return null
  const parts: [string, number, Code][] = [
    ['think', s.think, 't'],
    ['write', s.write, 'w'],
    ['text', s.text, 'x'],
    ['tools', s.tools, 'b'],
    ['stuck', s.stuck, 's'],
    ['wait', s.wait, 'q'],
  ]
  return (
    <Box key="time" flexDirection="column">
      {rule(el, width, 'TIME', 'where it went')}
      {paint(el, stacked(width, parts.map(([, v, code]) => ({ value: v, color: hex(STATE[code]) }))), 'timebar', terminal)}
      <Text mono wrap="truncate-end">
        {parts
          .filter(([, v]) => v > 0)
          .map(([label, v, code]) => (
            <Text mono>
              <Text mono color={STATE[code]}>{'■ '}</Text>
              <Text mono color={P.sub0}>{`${label} ${v}%   `}</Text>
            </Text>
          ))}
      </Text>
    </Box>
  )
}

export function legend(el: El) {
  const { Text } = el
  return (
    <Text mono wrap="truncate-end">
      {LEGEND.map(code => (
        <Text mono>
          <Text mono color={STATE[code]}>{code === 'i' ? '▁' : '▄'}</Text>
          <Text mono color={P.over0}>{`${WORD[code]}  `}</Text>
        </Text>
      ))}
    </Text>
  )
}
