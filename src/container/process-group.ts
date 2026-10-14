import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

export type ProcessGroupSignal = "HUP" | "INT" | "QUIT" | "TERM" | "USR1" | "USR2" | "KILL"

const EXEC_TIMEOUT_MS = 15000
const PIDFILE_POLL_MS = 150

export async function signalProcessGroup(
  transport: DockerTransport,
  target: SandboxTarget,
  op: string,
  signal: ProcessGroupSignal,
  opts: { waitForPidfileMs?: number; keepPidfile?: boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.waitForPidfileMs ?? 0)
  const pidfile = `/tmp/.dsh-pid-${op}`
  const cleanup = opts.keepPidfile ? "" : `rm -f ${pidfile}; `
  for (;;) {
    try {
      const result = await transport.execInContainer(
        target,
        ["sh", "-c", `pid=$(cat ${pidfile} 2>/dev/null); if [ -n "$pid" ]; then kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ${cleanup}echo SIGNALED; else echo NOPID; fi`],
        { timeoutMs: EXEC_TIMEOUT_MS },
      )
      if (result.stdout.toString("utf8").includes("SIGNALED")) return true
    } catch {
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, PIDFILE_POLL_MS))
  }
}
