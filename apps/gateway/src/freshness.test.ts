import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESH_MS, hasFreshConnection } from './freshness';

test('a user with no connections is offline', () => {
  assert.equal(hasFreshConnection({}, Date.now()), false);
});

test('a recently refreshed connection means online', () => {
  const now = 1_000_000;
  assert.equal(hasFreshConnection({ a: String(now - 10_000) }, now), true);
});

test('connections left behind by a crashed gateway are ignored once stale', () => {
  const now = 1_000_000;
  assert.equal(hasFreshConnection({ crashed: String(now - FRESH_MS - 1) }, now), false);
});

test('one live connection is enough even if another is stale', () => {
  const now = 1_000_000;
  assert.equal(
    hasFreshConnection({ crashed: String(now - 500_000), live: String(now - 1_000) }, now),
    true,
  );
});
