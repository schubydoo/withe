import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { clearAdapters, createAdapter, registerAdapter } from './registry.ts';
import type { SourceAdapter, SourceConfig, SourceKind } from './types.ts';

const stub = (config: SourceConfig): SourceAdapter => ({
  id: config.id,
  kind: config.kind,
  preflight: async () => ({ ok: true, problems: [], reachableButEmpty: false, compose: '' }),
  collect: async () => ({ repos: [], runs: [], updates: [], warnings: [] }),
  fetchLog: async () => new ReadableStream<Uint8Array>(),
});

afterEach(clearAdapters);

test('resolves a registered kind', () => {
  registerAdapter('ce', stub);
  const adapter = createAdapter({ id: 'home', kind: 'ce' });
  assert.equal(adapter.id, 'home');
  assert.equal(adapter.kind, 'ce');
});

test('an unknown kind names the kinds that exist', () => {
  assert.throws(
    () => createAdapter({ id: 'home', kind: 'sftp' as SourceKind }),
    /Unknown source kind 'sftp'.*Known kinds: ce, jsonlog, forge/s,
  );
});

test('a known kind with no adapter is reported as a build problem', () => {
  assert.throws(
    () => createAdapter({ id: 'home', kind: 'jsonlog' }),
    /known but no adapter is registered.*build problem/s,
  );
});

test('no adapter method can reach a database', () => {
  registerAdapter('ce', stub);
  const adapter = createAdapter({ id: 'home', kind: 'ce' });
  // The interface offers three methods and none of them takes a connection,
  // a transaction, or a writer. That is the whole enforcement at this layer;
  // Task 2.11 adds the lint rule that keeps it true inside implementations.
  assert.deepEqual(Object.keys(stub({ id: 'x', kind: 'ce' })).sort(), [
    'collect',
    'fetchLog',
    'id',
    'kind',
    'preflight',
  ]);
  assert.equal(typeof adapter.collect, 'function');
});
