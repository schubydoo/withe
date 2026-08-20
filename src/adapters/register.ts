/**
 * The composition root for adapters.
 *
 * Importing this registers every adapter Withe ships. It exists so that no
 * other file needs to name one: the web layer imports this and the registry,
 * and never `adapters/ce/`. That is what makes F-02's boundary checkable rather
 * than a convention, and `scripts/check-boundaries.ts` enforces it.
 */
import './ce/adapter.ts';
import './jsonlog/adapter.ts';

export { createAdapter } from './registry.ts';
