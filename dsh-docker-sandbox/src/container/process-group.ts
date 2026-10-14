
import type { SandboxTarget } from "./session.ts"
import type { DockerTransport } from "./transport.ts"

export type ProcessGroupSignal = "HUP" | "INT" | "QUIT" | "TERM" | "USR1" | "USR2" | "KILL"

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
        ["sh", "-c", `pid=$(cat /tmp/.dsh-pid-${op} 2>/dev/null); if [ -n "$pid" ]; then kill -${signal} -"$pid" 2>/dev/null || kill -${signal} "$pid" 2>/dev/null; ${cleanup}echo SIGNALED; else echo NOPID; fi`],
        { timeoutMs: 15000 },
      )
      if (result.stdout.toString("utf8").includes("SIGNALED")) return true
    } catch {
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
