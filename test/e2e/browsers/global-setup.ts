import { writeFileSync } from 'node:fs';

import { startStack, STATE_FILE, WEB_PORT } from './lifecycle.ts';

export default async function globalSetup(): Promise<void> {
  const state = startStack();
  writeFileSync(STATE_FILE, JSON.stringify(state));

  for (let i = 0; i < 150; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/health`);
      if (r.status === 200 || r.status === 503) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('web server never became ready for the cross-browser smoke');
}
