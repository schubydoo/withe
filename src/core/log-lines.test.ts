import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyFilter, isProblem, parseLines } from './log-lines.ts';

const FIXTURE = readFileSync('test/fixtures/ce/job.ndjson', 'utf8');

test('the recorded log parses with no malformed lines', () => {
  const parsed = parseLines(FIXTURE);
  assert.ok(parsed.lines.length > 0);
  assert.equal(parsed.malformed, 0);
  for (const line of parsed.lines) {
    assert.ok(line.entry, `line ${line.index} lost its entry`);
    assert.equal(typeof line.message, 'string');
  }
});

test('a line that is not JSON renders raw and is counted, without failing', () => {
  const text = [
    JSON.stringify({ level: 30, msg: 'first' }),
    'DEBUG: something printed straight to the stream',
    '{"truncated": ',
    JSON.stringify({ level: 30, msg: 'last' }),
  ].join('\n');

  const parsed = parseLines(text);
  assert.equal(parsed.lines.length, 4, 'no line may be dropped');
  assert.equal(parsed.malformed, 2);

  const raw = parsed.lines.filter((l) => l.level === 'raw');
  assert.equal(raw.length, 2);
  assert.equal(raw[0]?.message, 'DEBUG: something printed straight to the stream');
  assert.equal(raw[0]?.entry, null);

  // The lines around it are unaffected.
  assert.equal(parsed.lines[0]?.message, 'first');
  assert.equal(parsed.lines[3]?.message, 'last');
});

test('a JSON array or bare value is treated as raw, not as an entry', () => {
  const parsed = parseLines(['[1,2,3]', '"a string"', '42'].join('\n'));
  assert.equal(parsed.malformed, 3);
  assert.ok(parsed.lines.every((l) => l.level === 'raw'));
});

test('numeric and named levels both map', () => {
  const parsed = parseLines(
    [
      JSON.stringify({ level: 10, msg: 'a' }),
      JSON.stringify({ level: 40, msg: 'b' }),
      JSON.stringify({ level: 'ERROR', msg: 'c' }),
      JSON.stringify({ level: 99, msg: 'd' }),
      JSON.stringify({ msg: 'e' }),
    ].join('\n'),
  );
  assert.deepEqual(parsed.lines.map((l) => l.level), ['trace', 'warn', 'error', 'info', 'info']);
});

test('the first warning or worse is found, so the view can jump to it', () => {
  const text = [
    JSON.stringify({ level: 30, msg: 'a' }),
    JSON.stringify({ level: 20, msg: 'b' }),
    JSON.stringify({ level: 40, msg: 'the first problem' }),
    JSON.stringify({ level: 50, msg: 'a later one' }),
  ].join('\n');

  const parsed = parseLines(text);
  assert.equal(parsed.firstProblem, 2);
  assert.equal(parsed.lines[parsed.firstProblem]?.message, 'the first problem');

  assert.equal(parseLines(JSON.stringify({ level: 30, msg: 'calm' })).firstProblem, -1);
  assert.equal(isProblem('warn'), true);
  assert.equal(isProblem('debug'), false);
});

test('blank lines and a trailing newline produce no rows', () => {
  const parsed = parseLines(`${JSON.stringify({ level: 30, msg: 'only' })}\n\n\n`);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.malformed, 0);
});

test('filtering by level and by substring both work, and compose', () => {
  const parsed = parseLines(FIXTURE);
  const all = parsed.lines;

  const noFilter = applyFilter(all, { levels: [], search: '' });
  assert.equal(noFilter.length, all.length);

  const info = applyFilter(all, { levels: ['info'], search: '' });
  assert.ok(info.length > 0);
  assert.ok(info.every((l) => l.level === 'info'));

  // Search runs over the whole original line, so a field the viewer never
  // renders is still findable — which is most of what these logs carry.
  const hits = applyFilter(all, { levels: [], search: 'branchesInformation' });
  assert.ok(hits.length > 0, 'a field name that is never rendered must still be searchable');

  const both = applyFilter(all, { levels: ['info'], search: 'branchesInformation' });
  assert.ok(both.length <= Math.min(info.length, hits.length));
  assert.ok(both.every((l) => l.level === 'info' && l.raw.includes('branchesInformation')));
});

test('search is case-insensitive and trims', () => {
  const text = JSON.stringify({ level: 30, msg: 'Dependency extraction complete' });
  assert.equal(applyFilter(parseLines(text).lines, { levels: [], search: '  DEPENDENCY ' }).length, 1);
});

test('parsing 5000 lines stays well inside the budget for a first paint', () => {
  // NFR-3 gives the viewer 1000 ms to paint its first screen. Rendering is
  // windowed to roughly sixty rows, so parsing is the part that scales with the
  // log, and it is the part measurable without a browser. The paint itself is
  // for the end-to-end suite in Task 3.12.
  const line = JSON.stringify({
    level: 20,
    time: '2026-08-06T17:00:00.000Z',
    msg: 'http cache: Using cached response',
    repository: 'acme/widget',
    extra: 'x'.repeat(120),
  });
  const text = Array.from({ length: 5000 }, () => line).join('\n');

  const started = process.hrtime.bigint();
  const parsed = parseLines(text);
  const filtered = applyFilter(parsed.lines, { levels: ['debug'], search: 'cached' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(parsed.lines.length, 5000);
  assert.equal(filtered.length, 5000);
  assert.ok(ms < 500, `parsing and filtering 5000 lines took ${ms.toFixed(0)}ms`);
});
