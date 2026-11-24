import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFirstUrl, extractMentions } from './text';

test('extractMentions finds mentions and lowercases them', () => {
  assert.deepEqual(extractMentions('hi @alice and @Bob_99!'), ['alice', 'bob_99']);
});

test('extractMentions de-duplicates', () => {
  assert.deepEqual(extractMentions('@alice @alice, @alice'), ['alice']);
});

test('extractMentions ignores email addresses', () => {
  assert.deepEqual(extractMentions('mail me at someone@example.com'), []);
});

test('extractMentions handles a mention at the very start and after punctuation', () => {
  assert.deepEqual(extractMentions('@carol: look (@dave)'), ['carol', 'dave']);
});

test('extractMentions ignores names that are too short', () => {
  assert.deepEqual(extractMentions('hey @ab'), []);
});

test('extractFirstUrl returns the first link without trailing punctuation', () => {
  assert.equal(
    extractFirstUrl('read https://example.com/a?b=1, then http://other.test.'),
    'https://example.com/a?b=1',
  );
});

test('extractFirstUrl stops at closing brackets and quotes', () => {
  assert.equal(extractFirstUrl('(see https://example.com/page)'), 'https://example.com/page');
});

test('extractFirstUrl returns null when there is no link', () => {
  assert.equal(extractFirstUrl('ftp://nope and plain text'), null);
});
