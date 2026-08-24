/**
 * Where Withe listens, and whether that is safe (F-16, NFR-13, NFR-13b).
 *
 * The rule reads backwards from the deployment. A container cannot serve a
 * published port from loopback — Docker connects to the container's external
 * interface — so a container that binds `127.0.0.1` looks broken rather than
 * safe. Inside a container Withe binds `0.0.0.0` and containment moves to the
 * published address, which the README documents as `-p 127.0.0.1:8080:3000`.
 * Outside a container `127.0.0.1` is meaningful, so that is the default there.
 *
 * `WITHE_BIND` always wins. An operator who names an address has decided.
 */
import { existsSync, readFileSync } from 'node:fs';

/** The environment as read: names to values, with absent names undefined. */
export type Env = Record<string, string | undefined>;

export interface ContainerProbe {
  /** Docker writes this file into every container it creates. */
  markerFile(): boolean;
  /** `/proc/1/cgroup`, or null where it cannot be read. */
  cgroup(): string | null;
}

export const systemProbe: ContainerProbe = {
  markerFile: () => existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  cgroup: () => {
    try {
      return readFileSync('/proc/1/cgroup', 'utf8');
    } catch {
      return null;
    }
  },
};

const CONTAINER_CGROUP = /docker|kubepods|containerd|libpod|podman|lxc|crio|garden/i;
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Am I in a container? Three checks, in order of how much they can be trusted.
 *
 * `/.dockerenv` alone is unreliable — Podman and Kubernetes do not always write
 * it — so the cgroup line is read as well, and `WITHE_IN_CONTAINER` overrides
 * both for the case neither answers. Where nothing can be read at all the
 * answer is yes, because an unreachable service is a worse failure than a
 * process bound wider than it needed to be, and that case is warned about
 * loudly either way.
 */
export function inContainer(env: Env, probe: ContainerProbe = systemProbe): boolean {
  const override = env.WITHE_IN_CONTAINER?.trim();
  if (override) return TRUTHY.test(override);

  if (probe.markerFile()) return true;

  const cgroup = probe.cgroup();
  if (cgroup === null) return true;
  return CONTAINER_CGROUP.test(cgroup);
}

/** The address the web process listens on. */
export function bindAddress(env: Env, container: boolean): string {
  const explicit = env.WITHE_BIND?.trim();
  if (explicit) return explicit;
  return container ? '0.0.0.0' : '127.0.0.1';
}

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|localhost)$/i;

/** Can something other than this machine open the port? */
export function beyondLoopback(bind: string): boolean {
  return !LOOPBACK.test(bind.trim());
}

/**
 * Whether the operator has acknowledged running Withe open with no password.
 *
 * For a deployment that authenticates in front of Withe — a reverse proxy, a
 * VPN, an identity-aware gateway — the port is not really open, but Withe cannot
 * see that layer. This flag lets such an operator silence the warning without
 * setting credentials Withe would then also check. It hides the message; it adds
 * no protection.
 */
export function acknowledgeExposure(env: Env): boolean {
  const value = env.WITHE_ACKNOWLEDGE_EXPOSURE?.trim();
  return value ? TRUTHY.test(value) : false;
}

/**
 * The one sentence an operator needs when Withe is open to the network.
 *
 * It names the risk and both variables that close it. Returned rather than
 * printed so the same words appear at startup and in the banner — an operator
 * who reads one and then the other should not have to work out that they are
 * the same problem. An operator who has acknowledged the exposure (secured it
 * outside Withe) gets no warning; the sentence keeps naming the real fixes
 * rather than advertising the switch that hides it.
 */
export function exposureWarning(
  bind: string,
  hasCredentials: boolean,
  acknowledged = false,
): string | null {
  if (hasCredentials || acknowledged || !beyondLoopback(bind)) return null;
  return (
    `Withe is listening on ${bind} with no password. ` +
    `Anyone who can reach this port can read every repository, run and log it holds. ` +
    `Set WITHE_AUTH_USER and WITHE_AUTH_PASS, or set WITHE_BIND=127.0.0.1 to close it.`
  );
}

/**
 * The startup line that records a warning was silenced, so an acknowledged-open
 * Withe does not look identical to a closed one in the logs. Printed at startup
 * only, never bannered — the flag suppresses the page warning, not the audit
 * trail. Null unless the flag actually hid a real warning: an acknowledgement
 * that suppresses nothing (loopback, or credentials set) records nothing.
 */
export function suppressionNotice(
  bind: string,
  hasCredentials: boolean,
  acknowledged: boolean,
): string | null {
  if (!acknowledged) return null;
  if (exposureWarning(bind, hasCredentials, false) === null) return null;
  return (
    `Withe is open on ${bind} with no password; its exposure warning is silenced ` +
    `by WITHE_ACKNOWLEDGE_EXPOSURE. Access must be controlled in front of Withe.`
  );
}
