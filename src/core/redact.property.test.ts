import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { redact, REDACTED } from './redact.ts';

// Property-based tests for the redaction filter (NFR-12, SEC-7). The example
// tests in redact.test.ts fix one input each; these state a rule that must hold
// for every input and let fast-check generate cases to break it. When a rule
// fails, fast-check shrinks the input to the smallest counterexample and prints
// a seed, so the failure reproduces with fc.assert(prop, { seed }).

// The characters a real credential is built from. A secret drawn from this set
// holds no guillemet, so it can never be a substring of REDACTED and redaction
// can never rebuild it from the marker and its neighbours.
const CREDENTIAL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// A token-shaped string of `min` to `max` characters. Built from array and
// constantFrom, which keep the same meaning across fast-check major versions.
const credential = (min: number, max: number) =>
  fc
    .array(fc.constantFrom(...CREDENTIAL_CHARS), { minLength: min, maxLength: max })
    .map((chars) => chars.join(''));

test('property: redact returns a string for any input and never throws', () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      assert.equal(typeof redact(text), 'string');
    }),
  );
});

test('property: a configured secret never survives, wherever it sits in the line', () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), credential(16, 40), (before, after, secret) => {
      const out = redact(`${before}${secret}${after}`, [secret]);
      assert.equal(out.includes(secret), false);
    }),
  );
});

test('property: a GitHub token shape is always redacted', () => {
  fc.assert(
    fc.property(credential(20, 40), (body) => {
      const token = `ghp_${body}`;
      const out = redact(`cloning with ${token} now`);
      assert.equal(out.includes(token), false);
      assert.ok(out.includes(REDACTED));
    }),
  );
});

test('property: redacting twice gives the same line as redacting once', () => {
  fc.assert(
    fc.property(fc.string(), credential(16, 40), (text, secret) => {
      const once = redact(text, [secret]);
      assert.equal(redact(once, [secret]), once);
    }),
  );
});
