import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LogProblemRow } from '../../db/queries.ts';
import { isActive, NO_PROBLEM_FILTER, readProblemFilter, rowKey } from './filter.ts';

function row(over: Partial<LogProblemRow>): LogProblemRow {
  return {
    runId: 1,
    repoFullName: 'acme/widget',
    sourceAdapterId: 'src',
    level: 'warn',
    message: 'Package lookup failure',
    occurrences: 1,
    at: new Date('2026-09-01T00:00:00Z'),
    ...over,
  };
}

test('readProblemFilter reads a search and a level', () => {
  assert.deepEqual(readProblemFilter({ q: 'timeout', level: 'error' }), {
    query: 'timeout',
    level: 'error',
  });
});

test('a blank or absent search is the same as no search', () => {
  assert.deepEqual(readProblemFilter({}), NO_PROBLEM_FILTER);
  assert.deepEqual(readProblemFilter({ q: '' }), NO_PROBLEM_FILTER);
  assert.deepEqual(readProblemFilter({ q: '   ' }), NO_PROBLEM_FILTER);
});

test('the search is trimmed, so a stray space does not change the result', () => {
  assert.equal(readProblemFilter({ q: '  timeout  ' }).query, 'timeout');
});

test('an unknown level is dropped rather than rejected', () => {
  // A hand-edited URL or a stale bookmark shows every level, not an error page.
  assert.equal(readProblemFilter({ level: 'nonsense' }).level, null);
  assert.equal(readProblemFilter({ level: 'info' }).level, null);
});

test('a repeated key reads its last value, the way a resubmit leaves it', () => {
  assert.deepEqual(readProblemFilter({ q: ['old', 'new'], level: ['warn', 'fatal'] }), {
    query: 'new',
    level: 'fatal',
  });
});

test('isActive is true when either control is set', () => {
  assert.equal(isActive(NO_PROBLEM_FILTER), false);
  assert.equal(isActive({ query: 'timeout', level: null }), true);
  assert.equal(isActive({ query: null, level: 'fatal' }), true);
});

test('the same line in two runs gets two keys', () => {
  // The fleet-wide list is exactly where one message appears many times, so a
  // key on the message alone would collide across repositories.
  assert.notEqual(rowKey(row({ runId: 1 })), rowKey(row({ runId: 2 })));
});

test('the row key separates every field that names a row', () => {
  const base = row({});
  for (const change of [{ runId: 9 }, { level: 'fatal' as const }, { message: 'other' }]) {
    assert.notEqual(rowKey(row(change)), rowKey(base), `${Object.keys(change)[0]} is not in the key`);
  }
});

test('two rows alike in every keyed field share a key', () => {
  // The negative half: the test above passes trivially if the key were random.
  assert.equal(rowKey(row({})), rowKey(row({})));
});
