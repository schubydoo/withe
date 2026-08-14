/**
 * The first check every request meets (F-16, NFR-13a).
 *
 * This is `proxy.ts`, not `middleware.ts`. Next.js 16 deprecated the older
 * filename and renamed the export with it. One consequence matters here: the
 * proxy runs on the Node.js runtime and cannot be moved to the edge one, so
 * `crypto.timingSafeEqual` is available to the check it calls.
 *
 * It is the first check, not the only one. The framework treats this layer as
 * a convenience rather than an authorization boundary, and it has a bypass
 * history, so `/api/runs/[id]/log` — the one route that returns real
 * repository content — repeats the check inside the handler.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { loadConfig } from './config/load.ts';
import { authGuard, type Credentials } from './core/basic-auth.ts';

let configured: Credentials | null | undefined;

/**
 * Read the credentials once per process.
 *
 * A configuration error throws on every request rather than once at startup,
 * which is noisy but closed. Half-configured authentication is the shape that
 * leaves a dashboard open while its operator believes it is shut, so this must
 * not degrade into letting requests through.
 */
function credentials(): Credentials | null {
  if (configured === undefined) configured = loadConfig().auth;
  return configured;
}

export async function proxy(request: NextRequest): Promise<Response> {
  const refusal = await authGuard(request, request.nextUrl.pathname, credentials());
  return refusal ?? NextResponse.next();
}

export const config = {
  // Everything except the build's own assets, which carry no data and are
  // needed to render the login-protected pages once a credential is accepted.
  // Pages and route handlers alike fall inside this pattern.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
