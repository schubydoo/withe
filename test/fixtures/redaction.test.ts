import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = 'test/fixtures';

/**
 * Things that must never reach a committed fixture.
 *
 * Checking by eye misses the fourth file. The org and repository names below
 * are public, but they are still the author's, and a fixture corpus that names
 * a real fleet is a fixture corpus nobody else can read as an example.
 */
const DENY: readonly (readonly [string, RegExp])[] = [
  ['author org', /schubydoo/i],
  ['real repo names', /\b(clauster|claustrum|claustodian|podspine|balenamcp|dump1090-exporter|autohupr|renovate-config)\b/],
  ['bot account', /renokeeper/i],
  ['the server port', /:7623\b/],
  ['a private host', /\b(?!127\.0\.0\.1)\d{1,3}(\.\d{1,3}){3}\b/],
  ['a bearer token', /\bBearer\s+\S{16,}/i],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  // Renovate logs carry 40- and 64-character hex digests by design — git SHAs
  // and image digests — so those are excluded. What is left is the shape a
  // base64 credential takes.
  ['a long opaque secret', /\b(?![0-9a-f]{40}\b)(?![0-9a-f]{64}\b)[A-Za-z0-9+/]{40,}={0,2}\b/],
];

function everyFile(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? everyFile(path) : [path];
  });
}

const files = everyFile(ROOT).filter((f) => !f.endsWith('.test.ts'));

test('the corpus is not empty, so a passing scan means something', () => {
  assert.ok(files.length >= 5, `expected fixtures, found ${files.length}`);
});

for (const file of files) {
  test(`${file} carries nothing that should not be published`, () => {
    const text = readFileSync(file, 'utf8');
    for (const [label, pattern] of DENY) {
      assert.equal(pattern.test(text), false, `${file} contains ${label}`);
    }
    // Whatever token this machine holds, if the runner has one.
    const live = process.env.WITHE_CE_TOKEN;
    if (live && live.length > 8) {
      assert.equal(text.includes(live), false, `${file} contains the live token`);
    }
  });
}

test('the denylist can actually fire', () => {
  // Absence of evidence is not evidence of absence: prove the instrument works
  // before trusting a clean scan.
  const planted =
    'a run for schubydoo/clauster by renokeeper[bot] on 10.0.0.5:7623 ' +
    'with Authorization: Bearer c2VjcmV0LXRva2VuLXZhbHVlLXRoYXQtaXMtbG9uZy1lbm91Z2g=';
  const caught = DENY.filter(([, pattern]) => pattern.test(planted)).map(([label]) => label);
  for (const expected of ['author org', 'real repo names', 'bot account', 'the server port', 'a private host', 'a bearer token', 'a long opaque secret']) {
    assert.ok(caught.includes(expected), `the '${expected}' rule did not fire on planted text`);
  }

  // ...and does not fire on the digests Renovate logs legitimately.
  const legitimate = 'currentDigest 9db594c7a0e82298c121c18b7f08aa1579ce7341';
  assert.deepEqual(DENY.filter(([, p]) => p.test(legitimate)).map(([l]) => l), []);
});
