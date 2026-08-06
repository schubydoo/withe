'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  applyFilter,
  isProblem,
  LEVELS,
  parseLines,
  type LevelName,
  type LogLine,
} from '../../../core/log-lines.ts';

/**
 * Row height in pixels.
 *
 * Lines do not wrap, so every row is the same height and windowing needs no
 * measurement pass. tad.md 4.6 assumed wrapping and therefore variable heights;
 * not wrapping is what log viewers normally do, and it removes the most
 * expensive part of this component. The trade is a horizontal scrollbar on long
 * lines, and an expander for reading one in full.
 */
const ROW = 22;
const OVERSCAN = 20;

const TONE: Record<LevelName, string> = {
  trace: 'text-neutral-400',
  debug: 'text-neutral-500',
  info: 'text-neutral-800',
  warn: 'text-amber-700',
  error: 'text-red-700',
  fatal: 'text-red-800',
  raw: 'text-purple-700',
};

const ALL_LEVELS = [...new Set(Object.values(LEVELS))] as LevelName[];

export function LogViewer({ runId }: { runId: number }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState('');
  const [levels, setLevels] = useState<LevelName[]>([]);
  const [search, setSearch] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [open, setOpen] = useState<number | null>(null);

  const viewport = useRef<HTMLDivElement>(null);
  const jumped = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`/api/runs/${runId}/log`, { signal: controller.signal });
        if (!response.ok || !response.body) {
          const body: unknown = await response.json().catch(() => null);
          const message =
            body && typeof body === 'object' && 'error' in body
              ? String((body as { error: unknown }).error)
              : `The server answered ${response.status}.`;
          setFailure(message);
          setState('error');
          return;
        }

        // Consumed as it arrives. A log is hundreds of kilobytes and the first
        // screen should not wait for the last byte.
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          setText(buffer);
        }
        setState('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setFailure(cause instanceof Error ? cause.message : String(cause));
        setState('error');
      }
    })();

    return () => controller.abort();
  }, [runId]);

  const parsed = useMemo(() => parseLines(text), [text]);
  const visible = useMemo(
    () => applyFilter(parsed.lines, { levels, search }),
    [parsed.lines, levels, search],
  );

  useEffect(() => {
    const measure = () => setHeight(Math.max(240, window.innerHeight - 260));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Jump to the first warning or error once, when the log has finished
  // arriving. Doing it per chunk would fight the operator for the scrollbar.
  useEffect(() => {
    if (jumped.current || state !== 'ready' || parsed.firstProblem < 0) return;
    jumped.current = true;
    viewport.current?.scrollTo({ top: Math.max(0, (parsed.firstProblem - 3) * ROW) });
  }, [state, parsed.firstProblem]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(visible.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const window_ = visible.slice(first, last);

  const problems = parsed.lines.filter((l) => isProblem(l.level)).length;

  if (state === 'error') {
    return (
      <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        {failure}
      </p>
    );
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="sr-only">Search the log</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search every field"
            className="w-64 rounded border border-neutral-300 px-2 py-1"
          />
        </label>

        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Filter by level</legend>
          {ALL_LEVELS.map((level) => {
            const on = levels.includes(level);
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setLevels((current) =>
                    current.includes(level)
                      ? current.filter((l) => l !== level)
                      : [...current, level],
                  )
                }
                className={`rounded px-2 py-0.5 text-xs ${
                  on ? 'bg-neutral-800 text-white' : 'bg-neutral-100 text-neutral-700'
                }`}
              >
                {level}
              </button>
            );
          })}
        </fieldset>

        <span className="text-neutral-500">
          {visible.length === parsed.lines.length
            ? `${parsed.lines.length} lines`
            : `${visible.length} of ${parsed.lines.length} lines`}
          {problems > 0 && ` · ${problems} warn or worse`}
          {parsed.malformed > 0 && ` · ${parsed.malformed} not JSON`}
          {state === 'loading' && ' · still arriving'}
        </span>
      </div>

      <div
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ height }}
        className="mt-3 overflow-auto rounded border border-neutral-200 bg-neutral-50 font-mono text-xs"
        role="log"
        aria-label="Run log"
      >
        {/* One tall spacer holds the scrollbar; only the visible slice exists. */}
        <div style={{ height: visible.length * ROW, position: 'relative' }}>
          {window_.map((line, offset) => (
            <Row
              key={line.index}
              line={line}
              top={(first + offset) * ROW}
              expanded={open === line.index}
              onToggle={() => setOpen(open === line.index ? null : line.index)}
            />
          ))}
        </div>
      </div>

      {open !== null && <Detail line={visible.find((l) => l.index === open) ?? null} />}
    </div>
  );
}

function Row({
  line,
  top,
  expanded,
  onToggle,
}: {
  line: LogLine;
  top: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      style={{ position: 'absolute', top, height: ROW }}
      className={`flex w-full items-center gap-3 whitespace-pre px-2 text-left hover:bg-neutral-100 ${
        expanded ? 'bg-neutral-200' : ''
      }`}
    >
      <span className="w-12 shrink-0 text-right text-neutral-400">{line.index + 1}</span>
      <span className={`w-12 shrink-0 uppercase ${TONE[line.level]}`}>{line.level}</span>
      <span className={TONE[line.level]}>{line.message}</span>
    </button>
  );
}

function Detail({ line }: { line: LogLine | null }) {
  if (!line) return null;
  return (
    <pre className="mt-3 max-h-96 overflow-auto rounded border border-neutral-200 bg-white p-3 text-xs">
      {line.entry ? JSON.stringify(line.entry, null, 2) : line.raw}
    </pre>
  );
}
