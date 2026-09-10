/**
 * The concurrency helper, re-exported from core.
 *
 * Section 4.3 caps concurrency to one CE server at 4. That is not politeness:
 * the Terms permit suspension or IP blocking for disproportionate load, so the
 * cap the adapter passes is a contractual limit (tad.md Section 7.6). The helper
 * itself is generic and lives in `src/core/concurrency.ts`.
 */
export { mapWithLimit } from '../../core/concurrency.ts';
