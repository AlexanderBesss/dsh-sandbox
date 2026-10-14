// run.sh setsid's each command and records its pgid in /tmp/.dsh-pid-<op>; killing the local exec client does not stop it

import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

// BusyBox kill signal names, without the SIG prefix
export type ProcessGroupSignal = "HUP" | "INT" | "QUIT" | "TERM" | "USR1" | "USR2" | "KILL"

export async function signalProcessGroup(
  transport: DockerTransport,
  target: SandboxTarget,
  op: string,
  signal: ProcessGroupSignal,
  opts: { waitForPidfileMs?: number; keepPidfile?: boolean } = {},
): Promise<boolean> {
  // the runner writes the pidfile a moment after the exec starts; a cancel landing before then would signal nothing
  const deadline = Date.now() + (opts.waitForPidfileMs ?? 0)
  // terminal sessions keep running after a signal and need the recorded group later; a terminated command's pidfile has no further use
  const cleanup = opts.keepPidfile ? "" : `rm -f /tmp/.dsh-pid-${op}; `
  for (;;) {
    try {
      const result = await transport.execInContainer(
        target,
        // BusyBox kill needs no `--`: a negative pid is already read as a process group; the bare kill covers images without setsid
        ["sh", "-c", `pid=$(cat /tmp/.dsh-pid-${op} 2>/dev/null); if [ -n "$pid" ]; then kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ${cleanup}echo SIGNALED; else echo NOPID; fi`],
        { timeoutMs: 15000 },
      )
      if (result.stdout.toString("utf8").includes("SIGNALED")) return true
    } catch {
      // the container may already be gone; the local client was killed first
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
