import { expect, test } from 'claude-code/testing'

import { Canvas, paint } from '../hooks/art'
import { rule } from '../hooks/look'

type Node = { type?: unknown; props?: Record<string, unknown>; children?: Node }

const el = { Box: 'Box', Text: 'Text', Raster: 'Raster' }

// Every Text in a returned element tree, outer and nested.
function texts(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach(n => texts(n, out))
  else if (node && typeof node === 'object') {
    const n = node as Node
    if (n.type === 'Text') out.push(n)
    texts(n.children, out)
  }
  return out
}

function canvas(): Canvas {
  const c = new Canvas(6, 2)
  c.text(0, 0, 'ab', 0xf38ba8)
  c.text(0, 1, 'cd', 0x01000000, 0x313244)
  return c
}

test('paint on a non-terminal surface gives every Text mono, nested ones included', () => {
  const tree = paint(el, canvas(), 'art', false)
  const found = texts(tree)
  expect(found.length).toBeGreaterThan(2)
  for (const t of found) expect(t.props?.mono).toBe(true)
})

test('rule gives every Text mono, nested ones included', () => {
  const found = texts(rule(el, 60, 'TITLE', 'info'))
  expect(found.length).toBe(5)
  for (const t of found) expect(t.props?.mono).toBe(true)
})

test('paint on the terminal still returns a Raster', () => {
  const tree = paint(el, canvas(), 'art', true) as unknown as Node
  expect(tree.type).toBe('Raster')
  expect(texts(tree)).toEqual([])
})
