import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isThemePreference, resolveDark } from './theme.ts';

test('resolveDark forces the chosen theme and ignores the OS', () => {
  assert.equal(resolveDark('dark', false), true);
  assert.equal(resolveDark('dark', true), true);
  assert.equal(resolveDark('light', true), false);
  assert.equal(resolveDark('light', false), false);
});

test('resolveDark follows the OS when the preference is system', () => {
  assert.equal(resolveDark('system', true), true);
  assert.equal(resolveDark('system', false), false);
});

test('isThemePreference accepts the three known values and nothing else', () => {
  for (const value of ['system', 'light', 'dark']) assert.equal(isThemePreference(value), true);
  for (const value of [null, undefined, '', 'auto', 'Dark', 1]) {
    assert.equal(isThemePreference(value), false);
  }
});
