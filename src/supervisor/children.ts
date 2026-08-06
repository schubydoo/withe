/**
 * Child process supervision.
 *
 * Separated from `main.ts` so the restart and signal paths can be tested with
 * real child processes and a controlled clock. TR-5 rates this High impact, and
 * the code that keeps a container alive is not something to assume works.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SupervisorOptions {
  /** How long a child must stay up before its failure count resets. */
  healthyAfterMs?: number;
  /** Consecutive failures before the supervisor gives up. */
  maxConsecutiveFailures?: number;
  /** Longest wait between restarts. */
  maxBackoffMs?: number;
  /** How long children get to exit after SIGTERM before they are killed. */
  drainMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  spawn?: typeof nodeSpawn;
}

/** Doubling from one second, capped. Section 4.1 caps this at 60 seconds. */
export function restartDelayMs(failures: number, maxMs: number): number {
  if (failures < 1) return 0;
  return Math.min(1000 * 2 ** (failures - 1), maxMs);
}

interface Supervised {
  spec: ChildSpec;
  process: ChildProcess | null;
  failures: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Supervisor {
  private readonly children = new Map<string, Supervised>();
  private readonly options: Required<Omit<SupervisorOptions, 'spawn'>> & { spawn: typeof nodeSpawn };
  private stopping = false;
  /** Resolves when the supervisor decides it is finished, with an exit code. */
  private settle: ((code: number) => void) | null = null;
  private readonly finished: Promise<number>;

  constructor(specs: readonly ChildSpec[], options: SupervisorOptions = {}) {
    this.options = {
      healthyAfterMs: options.healthyAfterMs ?? 10_000,
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      drainMs: options.drainMs ?? 10_000,
      now: options.now ?? (() => Date.now()),
      log: options.log ?? ((message) => console.log(message)),
      spawn: options.spawn ?? nodeSpawn,
    };
    for (const spec of specs) {
      this.children.set(spec.name, { spec, process: null, failures: 0, startedAt: 0, timer: null });
    }
    this.finished = new Promise<number>((resolve) => {
      this.settle = resolve;
    });
  }

  /** Start every child and resolve with the process exit code when finished. */
  run(): Promise<number> {
    for (const child of this.children.values()) this.startChild(child);
    return this.finished;
  }

  /** Which children are currently up. Used by the tests and by /health later. */
  get running(): string[] {
    return [...this.children.values()].filter((c) => c.process !== null).map((c) => c.spec.name);
  }

  private startChild(child: Supervised): void {
    if (this.stopping) return;

    child.startedAt = this.options.now();
    const proc = this.options.spawn(child.spec.command, child.spec.args, {
      stdio: 'inherit',
      env: { ...process.env, ...child.spec.env },
    });
    child.process = proc;
    this.options.log(`supervisor: started ${child.spec.name} (pid ${proc.pid ?? '?'})`);

    proc.on('exit', (code, signal) => {
      child.process = null;
      if (this.stopping) {
        this.options.log(`supervisor: ${child.spec.name} exited during shutdown`);
        this.finishIfDrained();
        return;
      }
      this.onCrash(child, code, signal);
    });

    proc.on('error', (cause: Error) => {
      // spawn itself failed — a missing binary, usually. The exit handler does
      // not fire for this, so the failure is counted here instead.
      child.process = null;
      this.options.log(`supervisor: ${child.spec.name} could not start: ${cause.message}`);
      this.onCrash(child, null, null);
    });
  }

  private onCrash(child: Supervised, code: number | null, signal: string | null): void {
    const uptime = this.options.now() - child.startedAt;
    // A child that ran long enough to be useful is treated as having recovered,
    // so a crash after a week does not inherit a failure count from the boot
    // that preceded it.
    if (uptime >= this.options.healthyAfterMs) child.failures = 0;
    child.failures += 1;

    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (child.failures >= this.options.maxConsecutiveFailures) {
      this.options.log(
        `supervisor: ${child.spec.name} failed ${child.failures} times in a row (${how}). ` +
          `Giving up so the container's restart policy takes over.`,
      );
      this.shutdown('SIGTERM', 1);
      return;
    }

    const delay = restartDelayMs(child.failures, this.options.maxBackoffMs);
    this.options.log(
      `supervisor: ${child.spec.name} exited with ${how} after ${uptime}ms, ` +
        `restart ${child.failures} in ${Math.round(delay / 1000)}s`,
    );
    // Not unref'd. Keeping the process alive until the child is back is the
    // supervisor's entire job, and an unref'd timer simply never fires when
    // nothing else holds the event loop open.
    child.timer = setTimeout(() => {
      child.timer = null;
      this.startChild(child);
    }, delay);
  }

  /**
   * Forward a signal to every child, then exit.
   *
   * Children get `drainMs` to leave on their own. Anything still alive is
   * killed, because a container that will not stop is worse than one that stops
   * abruptly.
   */
  shutdown(signal: NodeJS.Signals, exitCode = 0): void {
    if (this.stopping) return;
    this.stopping = true;
    this.options.log(`supervisor: ${signal} received, stopping children`);

    for (const child of this.children.values()) {
      if (child.timer) clearTimeout(child.timer);
      child.timer = null;
      child.process?.kill(signal);
    }

    const drain = setTimeout(() => {
      for (const child of this.children.values()) {
        if (child.process) {
          this.options.log(`supervisor: ${child.spec.name} did not stop in time, killing it`);
          child.process.kill('SIGKILL');
        }
      }
      this.settle?.(exitCode);
    }, this.options.drainMs);

    this.exitCode = exitCode;
    this.drainTimer = drain;
    this.finishIfDrained();
  }

  private exitCode = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private finishIfDrained(): void {
    if (!this.stopping) return;
    if (this.running.length > 0) return;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.settle?.(this.exitCode);
  }
}
