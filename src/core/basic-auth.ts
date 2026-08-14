/**
 * Optional HTTP basic authentication (F-16, NFR-13a).
 *
 * Off unless the operator sets both `WITHE_AUTH_USER` and `WITHE_AUTH_PASS`.
 * Withe has no accounts, sessions or roles — `prd.md` Section 3.4 excludes
 * them — so one shared credential is the whole model, and basic auth is a
 * floor beneath whatever the operator already runs in front of it.
 *
 * Two decisions this file exists to hold:
 *
 * Credentials are compared with `crypto.timingSafeEqual` over fixed-length
 * digests. `===` returns as soon as two bytes differ, which tells an attacker
 * how much of the password they have.
 *
 * Repeated failures from one address are delayed. It does not stop a
 * determined attacker, and it is not meant to; it removes the case where a
 * script tries a wordlist at the speed of the network.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface Credentials {
  user: string;
  pass: string;
}

/**
 * The one route that answers without credentials.
 *
 * It returns liveness and no data, so a container healthcheck does not need
 * the operator's password. Written here rather than in the proxy's matcher
 * because the log route repeats this check and must exempt the same path.
 * The route itself arrives in Task 3.6.
 */
export function isExempt(pathname: string): boolean {
  return pathname === '/api/health';
}

/** A fixed-length stand-in for a value of unknown length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Does an `Authorization` header carry the configured credentials?
 *
 * Both halves are compared before the result is combined, so a wrong username
 * costs the same time as a wrong password.
 */
export function credentialsMatch(expected: Credentials, header: string | null): boolean {
  if (!header) return false;

  const space = header.indexOf(' ');
  if (space < 0) return false;
  if (header.slice(0, space).toLowerCase() !== 'basic') return false;

  const decoded = Buffer.from(header.slice(space + 1).trim(), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;

  const userMatches = timingSafeEqual(digest(decoded.slice(0, colon)), digest(expected.user));
  const passMatches = timingSafeEqual(digest(decoded.slice(colon + 1)), digest(expected.pass));
  return userMatches && passMatches;
}

/** 401 with the challenge a browser needs to offer a login box. */
export function unauthorized(): Response {
  return new Response('Withe requires a username and password.\n', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="Withe", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export interface Throttle {
  /** Record a failure and return how long to wait before answering it. */
  penalty(address: string, now?: number): number;
  /** A correct credential clears the address's history. */
  forget(address: string): void;
}

interface Attempts {
  count: number;
  since: number;
}

const FREE_ATTEMPTS = 3;
const STEP_MS = 500;
const MAX_MS = 5000;
const WINDOW_MS = 300_000;
/** Above this many addresses, drop the ones whose window has closed. */
const SWEEP_AT = 1000;

/**
 * Count failures per address over a moving window.
 *
 * In memory and per process, which is the right size for a dashboard one
 * operator runs. A restart forgives every attacker, and that is acceptable:
 * this delays guessing, it does not lock an account.
 */
export function createThrottle(): Throttle {
  const seen = new Map<string, Attempts>();

  return {
    penalty(address: string, now: number = Date.now()): number {
      if (seen.size > SWEEP_AT) {
        for (const [key, attempts] of seen) {
          if (now - attempts.since > WINDOW_MS) seen.delete(key);
        }
      }

      const previous = seen.get(address);
      const attempts =
        previous && now - previous.since <= WINDOW_MS
          ? { count: previous.count + 1, since: previous.since }
          : { count: 1, since: now };
      seen.set(address, attempts);

      if (attempts.count <= FREE_ATTEMPTS) return 0;
      return Math.min(MAX_MS, (attempts.count - FREE_ATTEMPTS) * STEP_MS);
    },

    forget(address: string): void {
      seen.delete(address);
    },
  };
}

/**
 * Who is asking, as well as it can be known.
 *
 * Next sets `x-forwarded-for` from the connection, and Withe's own TLS proxy
 * forwards it, so the first entry is the closest thing to a client address a
 * route handler can see. Every unknown caller shares one bucket, which is
 * strict rather than permissive.
 */
export function addressOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'unknown';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const sharedThrottle = createThrottle();

/**
 * The check both the proxy layer and the log route run.
 *
 * Returns the response to send, or null to let the request through. Passing
 * `credentials` explicitly is what the tests do; the proxy reads them from the
 * configuration it already loaded.
 */
export async function authGuard(
  request: Request,
  pathname: string,
  credentials: Credentials | null,
  throttle: Throttle = sharedThrottle,
): Promise<Response | null> {
  if (!credentials) return null;
  if (isExempt(pathname)) return null;

  const address = addressOf(request);
  if (credentialsMatch(credentials, request.headers.get('authorization'))) {
    throttle.forget(address);
    return null;
  }

  const wait = throttle.penalty(address);
  if (wait > 0) await pause(wait);
  return unauthorized();
}
