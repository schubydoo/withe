/**
 * Kind to factory. The one place that knows which adapters exist.
 *
 * Adapters register themselves rather than being imported here, so that adding
 * the JSON-log adapter in v1.1 does not edit this file and the web layer never
 * gains a transitive import of an adapter's client library.
 */
import type { SourceAdapter, SourceAdapterFactory, SourceConfig, SourceKind } from './types.ts';

/** Every kind Withe knows about, whether or not one is registered yet. */
const KNOWN_KINDS: readonly SourceKind[] = ['ce', 'jsonlog', 'forge'];

const factories = new Map<SourceKind, SourceAdapterFactory>();

export function registerAdapter(kind: SourceKind, factory: SourceAdapterFactory): void {
  factories.set(kind, factory);
}

/** Test seam. Production code registers once at startup and never clears. */
export function clearAdapters(): void {
  factories.clear();
}

export function createAdapter(config: SourceConfig): SourceAdapter {
  if (!KNOWN_KINDS.includes(config.kind)) {
    throw new Error(
      `Unknown source kind '${config.kind}' for source '${config.id}'. ` +
        `Known kinds: ${KNOWN_KINDS.join(', ')}.`,
    );
  }

  const factory = factories.get(config.kind);
  if (!factory) {
    // A known kind with no factory means the build shipped without it, not that
    // the operator mistyped. Say which, so the report goes to the right place.
    throw new Error(
      `Source kind '${config.kind}' is known but no adapter is registered for it. ` +
        `This is a build problem in Withe, not a configuration error.`,
    );
  }

  return factory(config);
}
