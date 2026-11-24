import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SNOWFLAKE_EPOCH_MS,
  Snowflake,
  isMessageId,
  nodeIdFromString,
  snowflakeTimestamp,
} from './snowflake';

test('ids are unique and strictly increasing within one generator', () => {
  const gen = new Snowflake(1);
  let previous = 0n;
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) {
    const id = gen.next();
    assert.ok(BigInt(id) > previous, 'id must be greater than the previous one');
    assert.ok(!seen.has(id), 'id must be unique');
    seen.add(id);
    previous = BigInt(id);
  }
});

test('more than 4096 ids in the same millisecond still do not collide', () => {
  const gen = new Snowflake(7);
  const now = SNOWFLAKE_EPOCH_MS + 1000;
  const ids = new Set<string>();
  for (let i = 0; i < 10000; i++) ids.add(gen.next(now));
  assert.equal(ids.size, 10000);
});

test('ids never go backwards when the clock does', () => {
  const gen = new Snowflake(3);
  const first = gen.next(SNOWFLAKE_EPOCH_MS + 5000);
  const second = gen.next(SNOWFLAKE_EPOCH_MS + 4000);
  assert.ok(BigInt(second) > BigInt(first));
});

test('the timestamp can be read back out of an id', () => {
  const gen = new Snowflake(0);
  const now = SNOWFLAKE_EPOCH_MS + 123456789;
  assert.equal(snowflakeTimestamp(gen.next(now)), now);
});

test('different nodes produce different ids at the same instant', () => {
  const now = SNOWFLAKE_EPOCH_MS + 42;
  assert.notEqual(new Snowflake(1).next(now), new Snowflake(2).next(now));
});

test('node id must be in range', () => {
  assert.throws(() => new Snowflake(-1));
  assert.throws(() => new Snowflake(1024));
  assert.throws(() => new Snowflake(1.5));
});

test('isMessageId accepts only 64-bit decimal strings', () => {
  assert.equal(isMessageId('1'), true);
  assert.equal(isMessageId('9223372036854775807'), true);
  assert.equal(isMessageId('9223372036854775808'), false);
  assert.equal(isMessageId('12a'), false);
  assert.equal(isMessageId(''), false);
  assert.equal(isMessageId(12), false);
  assert.equal(isMessageId('-5'), false);
});

test('nodeIdFromString is stable and in range', () => {
  const a = nodeIdFromString('api-7d9f:412');
  assert.equal(a, nodeIdFromString('api-7d9f:412'));
  assert.ok(a >= 0 && a <= 1023);
  assert.notEqual(nodeIdFromString('api-1'), nodeIdFromString('api-2'));
});
