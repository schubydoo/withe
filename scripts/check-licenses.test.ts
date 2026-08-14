import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAgpl, licenseOf } from './check-licenses.ts';

test('AGPL is caught in every SPDX form it is written in', () => {
  for (const l of ['AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'AGPL-1.0', '(AGPL-3.0 OR MIT)']) {
    assert.equal(isAgpl(l), true, l);
  }
});

test('the licences Withe actually uses are not mistaken for AGPL', () => {
  for (const l of ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'BlueOak-1.0.0', '0BSD', 'LGPL-3.0']) {
    assert.equal(isAgpl(l), false, l);
  }
});

test('a licence is read from either SPDX field shape', () => {
  assert.equal(licenseOf({ license: 'MIT' }), 'MIT');
  assert.equal(licenseOf({ license: { type: 'MIT', url: 'x' } }), 'MIT');
  assert.equal(licenseOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), 'MIT OR Apache-2.0');
  assert.equal(licenseOf({}), 'UNKNOWN');
});
