import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SourceSystem } from '../../db/queries.ts';
import { systemPanel } from './system-panel.ts';

function system(over: Partial<SourceSystem> = {}): SourceSystem {
  return {
    sourceAdapterId: 's',
    kind: 'ce',
    reportsSystemFacts: true,
    queueDepth: null,
    oldestQueuedAt: null,
    oldestQueuedRepo: null,
    runnerVersion: null,
    bootedAt: null,
    ...over,
  };
}

test('a source with no server reports no-server, synced or not', () => {
  const noServer = system({ kind: 'jsonlog', reportsSystemFacts: false });
  // Decided before never-synced, so a log directory is never told facts are coming.
  assert.equal(systemPanel(noServer, false), 'no-server');
  assert.equal(systemPanel(noServer, true), 'no-server');
  // Even with facts somehow present, the kind has no server to attribute them to.
  assert.equal(systemPanel(system({ reportsSystemFacts: false, queueDepth: 3 }), true), 'no-server');
});

test('a server-backed source that has not synced reports never-synced', () => {
  assert.equal(systemPanel(system(), false), 'never-synced');
});

test('a synced server with facts reports facts', () => {
  assert.equal(systemPanel(system({ runnerVersion: '41.0.0' }), true), 'facts');
  assert.equal(systemPanel(system({ queueDepth: 0 }), true), 'facts');
});

test('a synced server with nothing to report reports api-off', () => {
  assert.equal(systemPanel(system(), true), 'api-off');
});
