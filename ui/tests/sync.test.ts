import assert from 'node:assert/strict'
import test from 'node:test'
import { syncEndpoint } from '../src/sync.ts'

test('builds an endpoint with an encoded name and token', () => {
  assert.equal(
    syncEndpoint('http://127.0.0.1:8080/', 'My project', 'a b+c'),
    'http://127.0.0.1:8080/api/sync/My%20project?token=a%20b%2Bc',
  )
})

test('omits an empty token', () => {
  assert.equal(
    syncEndpoint('http://host:8080', 'team', ''),
    'http://host:8080/api/sync/team',
  )
})
