import { readFileSync, rmSync } from 'node:fs';

import { STATE_FILE, type State } from './lifecycle.ts';

export default function globalTeardown(): void {
  let state: State;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return;
  }
  for (const pid of [state.webPid, state.stubPid]) {
    try {
      if (pid) process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  rmSync(state.work, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
}
