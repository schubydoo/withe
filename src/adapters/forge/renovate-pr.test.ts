import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_RENOVATE_AUTHORS,
  DEFAULT_RENOVATE_BRANCH_PREFIX,
  isRenovatePr,
  type RenovatePrRule,
} from './renovate-pr.ts';

const DEFAULT_RULE: RenovatePrRule = {
  branchPrefix: DEFAULT_RENOVATE_BRANCH_PREFIX,
  authorLogins: [...DEFAULT_RENOVATE_AUTHORS],
};

test('a renovate branch by the app bot is Renovate', () => {
  assert.equal(
    isRenovatePr({ headRef: 'renovate/next-16.x', authorLogin: 'renovate[bot]' }, DEFAULT_RULE),
    true,
  );
});

test('the branch prefix alone is not enough, because a human can name a branch the same way', () => {
  assert.equal(
    isRenovatePr({ headRef: 'renovate/hand-made', authorLogin: 'someone' }, DEFAULT_RULE),
    false,
  );
});

test('the author alone is not enough, because a bot opens other pull requests too', () => {
  assert.equal(
    isRenovatePr({ headRef: 'feature/x', authorLogin: 'renovate[bot]' }, DEFAULT_RULE),
    false,
  );
});

test('a missing branch or author is not Renovate', () => {
  assert.equal(isRenovatePr({ headRef: null, authorLogin: 'renovate[bot]' }, DEFAULT_RULE), false);
  assert.equal(isRenovatePr({ headRef: 'renovate/x', authorLogin: null }, DEFAULT_RULE), false);
});

test('the author match ignores case', () => {
  assert.equal(
    isRenovatePr({ headRef: 'renovate/x', authorLogin: 'Renovate[Bot]' }, DEFAULT_RULE),
    true,
  );
});

test('an operator prefix and a self-hosted bot login are honored', () => {
  const rule: RenovatePrRule = { branchPrefix: 'deps/', authorLogins: ['my-renovate-app[bot]'] };
  assert.equal(
    isRenovatePr({ headRef: 'deps/lodash-4.x', authorLogin: 'my-renovate-app[bot]' }, rule),
    true,
  );
  assert.equal(
    isRenovatePr({ headRef: 'renovate/lodash-4.x', authorLogin: 'my-renovate-app[bot]' }, rule),
    false,
  );
});
