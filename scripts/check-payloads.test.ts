import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBody, PLANTED } from './check-payloads.ts';

test('a secret anywhere in a response is found, including below the markup', () => {
  // The shape React writes: the markup is clean and the flight payload is not.
  const body =
    '<main><h1>Repositories</h1></main>' +
    `<script>self.__next_f.push([1,"{\\"token\\":\\"${PLANTED.token}\\"}"])</script>`;

  assert.deepEqual(checkBody('/repos', body, [PLANTED.token]), [
    { route: '/repos', secret: PLANTED.token },
  ]);
});

test('an ordinary page reports nothing', () => {
  assert.deepEqual(checkBody('/repos', '<main>acme/widget</main>', [PLANTED.token]), []);
});
