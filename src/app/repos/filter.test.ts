import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterRepos,
  isActive,
  matchesQuery,
  NO_FILTER,
  readFilter,
  REPO_STATES,
  repoState,
  type RepoState,
} from './filter.ts';

interface Row {
  org: string;
  name: string;
  removedAt: Date | null;
  enabled: boolean;
  stalled: boolean;
  lastRunStatus: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    org: 'schubydoo',
    name: 'withe',
    removedAt: null,
    enabled: true,
    stalled: false,
    lastRunStatus: 'success',
    ...over,
  };
}

test('repoState names the most decisive state first', () => {
  assert.equal(repoState(row()), 'active');
  assert.equal(repoState(row({ lastRunStatus: null })), 'no runs yet');
  assert.equal(repoState(row({ stalled: true })), 'stalled');
  assert.equal(repoState(row({ lastRunStatus: 'failed' })), 'failing');
  assert.equal(repoState(row({ enabled: false })), 'disabled');
  assert.equal(repoState(row({ removedAt: new Date(0) })), 'removed');
});

test('repoState prefers removed over every other state it also matches', () => {
  // A removed repository is disabled and stalled too; showing it as "stalled"
  // would send the operator looking for a run that will never come.
  const gone = row({ removedAt: new Date(0), enabled: false, stalled: true, lastRunStatus: 'failed' });
  assert.equal(repoState(gone), 'removed');
});

test('every state the badge can show is offered by the filter', () => {
  const reachable: RepoState[] = [
    repoState(row()),
    repoState(row({ lastRunStatus: null })),
    repoState(row({ stalled: true })),
    repoState(row({ lastRunStatus: 'failed' })),
    repoState(row({ enabled: false })),
    repoState(row({ removedAt: new Date(0) })),
  ];
  for (const state of reachable) {
    assert.ok(REPO_STATES.includes(state), `${state} is missing from the filter control`);
  }
});

test('matchesQuery matches org, name, and the org/name form, case-insensitively', () => {
  const r = row({ org: 'schubydoo', name: 'Withe' });
  assert.equal(matchesQuery(r, 'SCHUBY'), true);
  assert.equal(matchesQuery(r, 'withe'), true);
  assert.equal(matchesQuery(r, 'schubydoo/wi'), true);
  assert.equal(matchesQuery(r, 'renovate'), false);
  assert.equal(matchesQuery(r, ''), true);
});

test('readFilter trims the text and drops a state it does not know', () => {
  assert.deepEqual(readFilter({ q: '  withe  ', state: 'failing' }), { q: 'withe', state: 'failing' });
  assert.deepEqual(readFilter({ state: 'on fire' }), NO_FILTER);
  assert.deepEqual(readFilter({}), NO_FILTER);
});

test('readFilter reads the last value when a key repeats in the URL', () => {
  // `?q=a&q=b` reaches a page as an array. Calling .trim() on it would throw.
  assert.deepEqual(readFilter({ q: ['a', 'b'], state: ['active', 'failing'] }), {
    q: 'b',
    state: 'failing',
  });
  assert.deepEqual(readFilter({ q: [], state: [] }), NO_FILTER);
});

test('isActive is false only when neither field filters anything', () => {
  assert.equal(isActive(NO_FILTER), false);
  assert.equal(isActive({ q: 'a', state: null }), true);
  assert.equal(isActive({ q: '', state: 'active' }), true);
});

test('filterRepos leaves only rows matching both the state and the text', () => {
  const rows = [
    row({ org: 'acme', name: 'api', lastRunStatus: 'failed' }),
    row({ org: 'acme', name: 'web' }),
    row({ org: 'other', name: 'api-gateway', lastRunStatus: 'failed' }),
  ];

  assert.deepEqual(
    filterRepos(rows, { q: '', state: 'failing' }).map((r) => r.name),
    ['api', 'api-gateway'],
  );
  assert.deepEqual(
    filterRepos(rows, { q: 'acme', state: null }).map((r) => r.name),
    ['api', 'web'],
  );
  assert.deepEqual(
    filterRepos(rows, { q: 'acme', state: 'failing' }).map((r) => r.name),
    ['api'],
  );
  assert.deepEqual(filterRepos(rows, { q: 'acme', state: 'removed' }), []);
});

test('filterRepos returns the same array when nothing is filtered', () => {
  const rows = [row()];
  assert.equal(filterRepos(rows, NO_FILTER), rows);
});
