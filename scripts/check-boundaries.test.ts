import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkText, checkTree, RULES } from './check-boundaries.ts';

/** Every rule, with a violation and a line that must not trip it. */
const CASES: { rule: string; file: string; bad: string; good: string }[] = [
  {
    rule: 'no-generated-types-outside-adapter',
    file: 'src/app/page.tsx',
    bad: `import type { components } from '../adapters/ce/generated/ce.d.ts';`,
    good: `import type { Repo } from '../core/model.ts';`,
  },
  {
    rule: 'no-adapter-internals-in-web',
    file: 'src/app/preflight/page.tsx',
    bad: `import { CeAdapter } from '../../adapters/ce/adapter.ts';`,
    good: `import { createAdapter } from '../../adapters/register.ts';`,
  },
  {
    rule: 'no-adapter-branching-in-web',
    file: 'src/app/repos/page.tsx',
    bad: `if (source.kind === 'ce') { renderQueue(); }`,
    good: `if (source.kind === adapterKind) { renderQueue(); }`,
  },
  {
    rule: 'no-write-methods',
    file: 'src/adapters/ce/adapter.ts',
    bad: `await client.POST('/system/v1/jobs/add', { body });`,
    good: `await client.GET('/api/v1/orgs');`,
  },
  {
    rule: 'no-database-in-adapters',
    file: 'src/adapters/ce/adapter.ts',
    bad: `import { openDatabase } from '../../db/client.ts';`,
    good: `import type { Repo } from '../../core/model.ts';`,
  },
  {
    rule: 'no-filesystem-writes-in-adapters',
    file: 'src/adapters/jsonlog/adapter.ts',
    bad: `  unlinkSync(path); // prune the ingested log`,
    good: `  const text = readFileSync(path, 'utf8');`,
  },
  {
    rule: 'no-constructor-parameter-properties',
    file: 'src/worker/sync.ts',
    bad: `  constructor(private readonly db: Db, adapters: SourceAdapter[]) {`,
    good: `  constructor(db: Db, adapters: SourceAdapter[]) {`,
  },
];

test('every rule has a case, so none can be added without being proven', () => {
  assert.deepEqual(
    RULES.map((r) => r.name).sort(),
    CASES.map((c) => c.rule).sort(),
  );
});

for (const testCase of CASES) {
  test(`${testCase.rule} fails a deliberate violation`, () => {
    const found = checkText(testCase.file, testCase.bad);
    assert.ok(
      found.some((v) => v.rule === testCase.rule),
      `expected ${testCase.rule} to fire on: ${testCase.bad}`,
    );
    // A rule that fires must also say what to do instead.
    const violation = found.find((v) => v.rule === testCase.rule);
    assert.ok((violation?.detail.length ?? 0) > 20, 'a violation must explain the alternative');
  });

  test(`${testCase.rule} passes the correct form`, () => {
    const found = checkText(testCase.file, testCase.good);
    assert.deepEqual(
      found.filter((v) => v.rule === testCase.rule),
      [],
      `${testCase.rule} fired on the correct form: ${testCase.good}`,
    );
  });
}

test('a rule only inspects the files it is scoped to', () => {
  // The CE adapter may import its own generated types; that is the whole point
  // of the boundary being at its edge rather than inside it.
  const inside = checkText('src/adapters/ce/map.ts', CASES[0]!.bad);
  assert.deepEqual(inside.filter((v) => v.rule === 'no-generated-types-outside-adapter'), []);

  // The worker may talk to the database; only adapters may not.
  const worker = checkText('src/worker/sync.ts', CASES[4]!.bad);
  assert.deepEqual(worker.filter((v) => v.rule === 'no-database-in-adapters'), []);
});

test('a rule does not fire on the comment explaining it', () => {
  const commented = [
    `// Never write client.POST here.`,
    ` * import { openDatabase } from '../../db/client.ts';`,
  ].join('\n');
  assert.deepEqual(checkText('src/adapters/ce/adapter.ts', commented), []);
});

test('the tree is clean, and the checker is capable of saying otherwise', () => {
  assert.deepEqual(checkTree('src'), [], 'the source tree violates its own boundaries');

  // Absence of evidence is not evidence of absence: prove the same function
  // reports a violation when one exists.
  // That line trips two rules, and should: it is both a generated-types import
  // and a named-adapter import, and each sends the reader somewhere different.
  const planted = checkText('src/app/page.tsx', CASES[0]!.bad);
  assert.deepEqual(
    planted.map((v) => v.rule).sort(),
    ['no-adapter-internals-in-web', 'no-generated-types-outside-adapter'],
  );
});
