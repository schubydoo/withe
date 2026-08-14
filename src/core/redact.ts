/**
 * Nothing that looks like a credential reaches a log line (NFR-12, SEC-7).
 *
 * Two layers, because either alone fails. The patterns catch a shape Withe has
 * never seen — a token inside an upstream error message, a header echoed back
 * by a server. The exact secrets catch the one thing the patterns cannot know:
 * this deployment's own token, whatever shape the operator's forge gives it.
 *
 * The filter is installed over `console` rather than called at each site.
 * "Remember to redact" is a convention, and a convention holds until the
 * evening someone adds a `console.error(cause)` in a hurry.
 */

export const REDACTED = '«redacted»';

/**
 * Shapes that are credentials wherever they appear.
 *
 * Deliberately not here: 40- and 64-character hex digests. Renovate logs git
 * SHAs and image digests by the thousand, and redacting them would turn the
 * log viewer into a wall of «redacted» — which is how a redaction filter gets
 * switched off.
 */
const PATTERNS: readonly RegExp[] = [
  // Authorization: Bearer <token>, and the same in an upstream error message.
  /(\bBearer\s+)\S{8,}/gi,
  // MEND_RNV_ADMIN_API_SECRET=..., in an environment dump or a preflight line.
  /(\bMEND_RNV_[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*\s*[=:]\s*)\S+/gi,
  // Forge tokens, by their documented prefixes.
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgho_[A-Za-z0-9]{20,}/g,
  /\bghu_[A-Za-z0-9]{20,}/g,
  /\bghs_[A-Za-z0-9]{20,}/g,
  /\bghr_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  // A credential in a URL: https://user:token@host/... The `@` is matched by
  // a lookahead so it stays where it was; every capture is written before the
  // redaction, and a trailing one would land on the wrong side of it.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s@]+(?=@)/gi,
];

/**
 * Redact a string.
 *
 * `secrets` are exact values from the configuration — the CE token, the auth
 * password. Short ones are ignored: a two-character password would redact
 * every second word and hide the message it was protecting.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;

  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }

  for (const pattern of PATTERNS) {
    // Each pattern keeps whatever it captured — `Bearer `, `NAME=`, `user:` —
    // so a redacted line still says what kind of thing was removed.
    out = out.replace(pattern, (...args: unknown[]) => {
      // The callback's trailing arguments are the offset and the whole input.
      // Only what sits between them is a capture group, and dropping that
      // distinction puts the original line back into the redacted one.
      const kept = args
        .slice(1, -2)
        .filter((group): group is string => typeof group === 'string')
        .join('');
      return kept.length > 0 ? `${kept}${REDACTED}` : REDACTED;
    });
  }

  return out;
}

/** Every value in the configuration that must never be printed. */
export function secretsFrom(config: {
  sources: readonly { token?: string }[];
  auth: { pass: string } | null;
}): string[] {
  const secrets = config.sources.map((source) => source.token).filter((t): t is string => !!t);
  if (config.auth) secrets.push(config.auth.pass);
  return secrets;
}

type Console = Pick<typeof globalThis.console, 'log' | 'warn' | 'error' | 'debug' | 'info'>;

/**
 * Wrap `console` so every write passes through `redact` first.
 *
 * Call once, as early in a process as the configuration allows. Arguments that
 * are not strings are stringified first — `console.error(cause)` prints an
 * Error whose message is exactly where an upstream credential turns up.
 */
export function installRedaction(secrets: readonly string[], target: Console = console): void {
  for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]): void => {
      original(...args.map((arg) => redact(stringify(arg), secrets)));
    };
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}
