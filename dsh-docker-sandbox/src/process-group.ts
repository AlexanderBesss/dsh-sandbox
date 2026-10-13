/**
 * Signalling a command that runs inside the container.
 *
 * Killing the local `docker` client does not stop the process running inside
 * the container, so every command runs through `agent/run.sh`, which
 * `setsid`s the command and records its process-group id in
 * `/tmp/.dsh-pid-<op>`. This module sends a signal to that recorded process
 * group with a short second `docker exec`.
 *
 * Shared by the subprocess runtime (terminate and its KILL escalation) and
 * the terminal backend (a closed session stops the command its shell
 * started).
 *
 * @module dsh-docker-sandbox/process-group
 */

import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

/** Signals the container's BusyBox `kill` understands, without the `SIG` prefix. */
export type ProcessGroupSignal = "HUP" | "INT" | "QUIT" | "TERM" | "USR1" | "USR2" | "KILL"

/**
 * Signal the recorded process group inside the container.
 *
 * Shared with the terminal backend, whose shell also runs through `run.sh` so
 * a closed session can stop the command it started.
 *
 * @param opts.waitForPidfileMs - keep looking for the pidfile this long. The
 *   runner writes it a moment after the exec starts, and a cancellation that
 *   lands before then would otherwise signal nothing.
 * @param opts.keepPidfile - leave the pidfile in place. A terminal session
 *   keeps running after a signal, and its later signals (and its close) need
 *   the recorded group; a terminated command's pidfile has no further use.
 * @returns whether the signal reached a recorded process (`SIGNALED`), or was
 *   a no-op because no pidfile ever appeared / the container is gone.
 */
export async function signalProcessGroup(
  transport: DockerTransport,
  target: SandboxTarget,
  op: string,
  signal: ProcessGroupSignal,
  opts: { waitForPidfileMs?: number; keepPidfile?: boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.waitForPidfileMs ?? 0)
  const cleanup = opts.keepPidfile ? "" : `rm -f /tmp/.dsh-pid-${op}; `
  for (;;) {
    try {
      const result = await transport.execInContainer(
        target,
        // BusyBox `kill` has no `--` separator, and does not need one: a
        // negative target is already read as a process group. The group kill
        // is tried first (the runner `setsid`s its command, so the recorded
        // pid leads its own group); the bare kill covers images without
        // `setsid`, where the recorded pid is the command itself.
        ["sh", "-c", `pid=$(cat /tmp/.dsh-pid-${op} 2>/dev/null); if [ -n "$pid" ]; then kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ${cleanup}echo SIGNALED; else echo NOPID; fi`],
        { timeoutMs: 15000 },
      )
      if (result.stdout.toString("utf8").includes("SIGNALED")) return true
    } catch {
      // The container may already be gone; the local client was killed already.
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
