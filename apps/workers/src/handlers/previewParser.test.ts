import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateAddress, parsePreview } from './previewParser';

test('isPrivateAddress blocks loopback, private and link-local IPv4', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test('isPrivateAddress allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('isPrivateAddress handles IPv6, including IPv4-mapped addresses', () => {
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fd12:3456::1'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('isPrivateAddress refuses anything that is not an IP address', () => {
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress(''), true);
});

test('parsePreview prefers Open Graph tags', () => {
  const html = `<html><head><title>Plain title</title>
    <meta property="og:title" content="OG &amp; title">
    <meta content="OG description" property="og:description">
    </head></html>`;
  assert.deepEqual(parsePreview(html), { title: 'OG & title', description: 'OG description' });
});

test('parsePreview falls back to <title> and meta description', () => {
  const html = `<title>  Hello
     world </title><meta name="description" content="A page.">`;
  assert.deepEqual(parsePreview(html), { title: 'Hello world', description: 'A page.' });
});

test('parsePreview returns nulls for a page with no metadata', () => {
  assert.deepEqual(parsePreview('<html><body>hi</body></html>'), { title: null, description: null });
});

test('parsePreview truncates very long titles', () => {
  const { title } = parsePreview(`<title>${'x'.repeat(500)}</title>`);
  assert.equal(title?.length, 200);
});
