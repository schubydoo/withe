/**
 * Turn the architecture's rules into a failing build.
 *
 * F-02's boundary and NFR-11's read-only guarantee are otherwise conventions,
 * and a convention holds until the evening someone is in a hurry. Each rule
 * below states what it forbids and why, because a lint failure whose reason is
 * unclear gets suppressed rather than fixed.
 *
 * Written as a script rather than an ESLint configuration: the rules are
 * structural rather than stylistic, they need no type information, and this
 * costs no dependencies and runs in milliseconds.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

interface Rule {
  name: string;
  why: string;
  /** Which files it inspects. */
  applies: (file: string) => boolean;
  /** What it forbids, tested per line. */
  forbids: RegExp;
  detail: string;
}

const posix = (file: string): string => file.split(sep).join('/');

export const RULES: Rule[] = [
  {
    name: 'no-generated-types-outside-adapter',
    why: 'F-02: no source-specific type crosses the adapter boundary.',
    applies: (file) => !posix(file).startsWith('src/adapters/ce/'),
    forbids: /from\s+['"][^'"]*adapters\/ce\/generated/,
    detail: 'The generated client types belong to the CE adapter. Map to src/core/model.ts instead.',
  },
  {
    name: 'no-adapter-internals-in-web',
    why: 'F-02: the web layer must not know which adapters exist.',
    applies: (file) => posix(file).startsWith('src/app/'),
    forbids: /from\s+['"][^'"]*adapters\/(ce|jsonlog|forge)\//,
    detail:
      'Import src/adapters/register.ts and src/adapters/types.ts. Naming one adapter here is how a page ends up branching on the source.',
  },
  {
    name: 'no-adapter-branching-in-web',
    why: 'F-02 second criterion: no page component branches on the adapter.',
    applies: (file) => posix(file).startsWith('src/app/'),
    forbids: /\bkind\s*===\s*['"](ce|jsonlog|forge)['"]|\bsourceAdapterId\s*===\s*['"]/,
    detail: 'A page that treats one source differently is a page that must be edited for the next one.',
  },
  {
    name: 'no-write-methods',
    why: 'NFR-11: every call to a source is a read. The allowlist is empty and stays empty.',
    applies: (file) => posix(file).startsWith('src/'),
    forbids: /\bclient\s*\.\s*(POST|PUT|PATCH|DELETE)\b/,
    detail:
      'The specification contains four write operations Withe must never reach: /system/v1/sync, /system/v1/jobs/purge, /system/v1/jobs/add, and /api/v1/repos/{orgRepo}/-/jobs/run.',
  },
  {
    name: 'no-database-in-adapters',
    why: 'An adapter returns the model; the worker persists it. One owner for writes.',
    applies: (file) => posix(file).startsWith('src/adapters/'),
    forbids: /from\s+['"][^'"]*(db\/client|db\/schema|db\/persist|drizzle-orm)/,
    detail: 'Return a CollectResult and let the worker write it.',
  },
  {
    name: 'no-filesystem-writes-in-adapters',
    why: 'Task 4.5: log files are the operator\'s source record. Withe never deletes a file it did not create — and it creates none.',
    applies: (file) => posix(file).startsWith('src/adapters/') && !file.endsWith('.test.ts'),
    forbids: /\b(writeFileSync|writeFile|appendFileSync|appendFile|unlinkSync|unlink|rmSync|rmdirSync|renameSync|rename|truncateSync|truncate|mkdirSync|mkdir|createWriteStream|copyFileSync|copyFile)\s*\(/,
    detail: 'Adapters read a source; they never write to one. A log directory is mounted read-only, and the code must deserve that mount.',
  },
  {
    name: 'no-constructor-parameter-properties',
    why: 'Node runs TypeScript by stripping types, and this is a syntax transform.',
    applies: (file) => posix(file).startsWith('src/'),
    // `constructor(private readonly db: Db)` compiles under Next and is a
    // syntax error under `node --test`, so it passes review and breaks tests.
    forbids: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/,
    detail: 'Declare the field and assign it in the constructor body.',
  },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue;
      sources(path, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Check one file's text. Exported so the tests can feed it a violation. */
export function checkText(file: string, text: string): Violation[] {
  const found: Violation[] = [];
  for (const rule of RULES) {
    if (!rule.applies(file)) continue;
    for (const [index, line] of text.split('\n').entries()) {
      // A rule must not fire on the comment that explains it, or the file
      // documenting the rules becomes the thing that fails them.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (rule.forbids.test(line)) {
        found.push({ file, line: index + 1, rule: rule.name, detail: rule.detail });
      }
    }
  }
  return found;
}

export function checkTree(root = 'src'): Violation[] {
  return sources(root).flatMap((file) => checkText(relative('.', file), readFileSync(file, 'utf8')));
}

// Run directly, not when imported by the tests.
if (process.argv[1]?.endsWith('check-boundaries.ts')) {
  const violations = checkTree();
  if (violations.length === 0) {
    console.log(`boundaries: ${RULES.length} rules, no violations`);
    process.exit(0);
  }
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}  ${violation.rule}\n    ${violation.detail}`);
  }
  console.error(`\n${violations.length} boundary violations.`);
  process.exit(1);
}
