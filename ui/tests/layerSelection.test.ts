import assert from 'node:assert/strict'
import test from 'node:test'
import { rangeSelection } from '../src/layerSelection.ts'

const order = ['a', 'b', 'c', 'd', 'e']

test('shift selection spans the visible rows in both directions', () => {
  assert.deepEqual(rangeSelection(order, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeSelection(order, 'd', 'a'), ['a', 'b', 'c', 'd'])
})

test('shift selection without an anchor selects only the target', () => {
  assert.deepEqual(rangeSelection(order, null, 'c'), ['c'])
  assert.deepEqual(rangeSelection(order, 'missing', 'c'), ['c'])
})

test('unknown target stays selectable by itself', () => {
  assert.deepEqual(rangeSelection(order, 'a', 'missing'), ['missing'])
})
