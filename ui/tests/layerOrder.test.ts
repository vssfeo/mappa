import assert from 'node:assert/strict'
import test from 'node:test'

import { moveLayerId } from '../src/layerOrder.ts'

test('dragging moves a layer before or after a target', () => {
  assert.deepEqual(moveLayerId(['a', 'b', 'c'], 'a', 'c', false), [
    'b',
    'a',
    'c',
  ])
  assert.deepEqual(moveLayerId(['a', 'b', 'c'], 'a', 'c', true), [
    'b',
    'c',
    'a',
  ])
  assert.deepEqual(moveLayerId(['a', 'b', 'c'], 'c', 'a', false), [
    'c',
    'a',
    'b',
  ])
  assert.deepEqual(moveLayerId(['a', 'b', 'c'], 'b', 'b', true), [
    'a',
    'b',
    'c',
  ])
  assert.deepEqual(moveLayerId(['a', 'b'], 'x', 'a', false), ['a', 'b'])
  assert.deepEqual(moveLayerId(['a', 'b'], 'a', 'x', false), ['a', 'b'])
})
