/**
 * `ctx.shell` backed by `docker exec` into the conversation's container.
 *
 * The shell tool hands over command text and a working directory; the executor
 * decides where it runs. Here that is always the chat's own container, so a
 * `cd`, a `git commit`, or an `npm install` in one chat cannot touch another
 * chat's files or processes. The command runs under `shellArgv` (default
 * `/bin/sh -lc`) inside `agent/run.sh`, which records the process-group id so
 * that `kill()` and the deadline actually stop the process in the container
 * rather than just the local `docker` client.
 *
 * @module dsh-docker-sandbox/seams/shell
 */

import type { SandboxContext } from "../context.ts"
import { ShellExecutor, type ShellExecSpec, type ShellProcess } from "@deepseek-ai/dsh-shell"
import type { SandboxConfig } from "../config.ts"
import { PathMapper } from "../container/paths.ts"
import { Provisioner } from "../container/provisioner.ts"
import { resolveTarget, SandboxSessionError, type SandboxTarget } from "../container/session.ts"
import type { DockerTransport } from "../container/transport.ts"
import type { DockerSubprocessRuntime } from "./subprocess.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

export interface ShellDeps {
  subprocess: DockerSubprocessRuntime
  provisioner: Provisioner
  transport: DockerTransport
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

/**
 * PowerShell-only syntax the Linux container's shell cannot run.
 *
 * The app's Pwsh tool is a plain consumer of the `ctx.shell` seam: it hands
 * PowerShell text to whatever executor backs that seam, and here that is a
 * `docker exec /bin/sh -lc`. Rather than let dash answer `Get-Location: not
 * found` (exit 127, no explanation), the seam recognizes the dialect and
 * answers once, clearly. The markers are deliberately PowerShell-specific:
 * approved-verb cmdlets (`Get-ChildItem`, `Test-Path`), `$env:` lookup syntax,
 * and .NET type literals - none of which appear in POSIX commands.
 */
export function looksLikePowerShell(command: string): boolean {
  return (
    /\b(?:Get|Set|New|Test|Select|Remove|Add|Copy|Move|Invoke|Import|Export|Write|Read|Clear|ForEach|Where|Sort|Measure|Group|Format|Out|Push|Pop|ConvertFrom|ConvertTo|Compare|Tee)-[A-Z][A-Za-z]+/.test(command) ||
    /\$env:/.test(command) ||
    /\bAdd-Type\b/.test(command) ||
    /\[(?:System|Microsoft)\.[A-Za-z]/.test(command)
  )
}

/** What the guard answers, phrased to redirect the model to what works. */
const POWERSHELL_REJECTION =
  "dsh-docker-sandbox: PowerShell is not available in this sandbox. The session runs in a Linux " +
  "container whose shell is sh/bash, so PowerShell cmdlets (Get-Location, Test-Path, Select-String, " +
  "$env:NAME, ...) do not exist here. Use the Bash tool with POSIX commands instead: the workspace " +
  "is /workspace, and host drives appear as /c/..., /f/..., ... (exit 127 is synthesized by the " +
  "sandbox, not by a command)."

/**
 * A settled shell process carrying the guard's rejection, shaped exactly like
 * the real handle so the tool layer renders it as a completed 127 run.
 */
function rejectedProcess(message: string, timeoutMs: number, details: Record<string, unknown>): unknown {
  const reader = (text: string) => ({
    readFrom: (fromByte: number) => ({ text: text.slice(fromByte), nextOffset: text.length, lossy: false }),
    get text() {
      return text
    },
    get lossy() {
      return false
    },
    get bytes() {
      return text.length
    },
  })
  const stderr = reader(message)
  const stdout = reader("")
  return {
    status: "completed",
    exitCode: 127,
    signal: null,
    observed: { stdout, stderr },
    done: Promise.resolve(),
    readOutput: () => ({ delta: `[stderr]\n${message}`, lossy: false }),
    kill: () => false,
    result: () =>
      Promise.resolve({
        exitCode: 127,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs,
        stdout: { text: "", truncated: false },
        stderr: { text: message, truncated: false },
      }),
    get closed() {
      return true
    },
    details,
  }
}

export class DockerShellExecutor extends ShellExecutor {
  /** The same context, seen with the services this plugin reads. */
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: ShellDeps,
  ) {
    super(ctx, "shell")
  }

  /** Per-container shell choice, filled by the first command (see `shellArgvFor`). */
  private readonly shellArgvCache = new Map<string, string[]>()

  /**
   * Normalize a request into this world: the working directory becomes the
   * container path, and the container that will run it is stamped on the spec
   * so a later `execute` (or a log line) can name it.
   *
   * The whole target is stamped, not just the name: `execute` then never has to
   * ask who is calling, which matters because it can run after the initiating
   * agent's async chain has moved on.
   *
   * A resolved spec is also *complete*: the shipped shell tools read
   * `spec.timeoutMs` straight back (the `pwsh` tool hands it to the jobs
   * registry, which rejects an undefined deadline), so `resolve` fills the
   * deadline, expiry policy, and output cap exactly as the local executor does.
   */
  resolve(spec: ShellExecSpec): ShellExecSpec {
    const config = this.deps.config
    // `maxTimeoutMs` is the ceiling the config sets for a caller-supplied
    // deadline; the effective value is what the result echoes back, so a
    // clamped budget is visible rather than silent.
    const timeoutMs = Math.max(0, Math.min(spec.timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
    const filled = {
      ...spec,
      timeoutMs,
      onExpiry: spec.onExpiry ?? "kill",
      maxOutputBytes: spec.maxOutputBytes ?? config.maxOutputBytes.get(),
    }
    // A spec this executor already stamped carries its own target; re-asking
    // `agents` here would let a later call re-route it — to the shared
    // container under `allowAgentless`, or to whichever chat happens to be
    // active — or fail it outright when no initiator is in the chain.
    if (typeof spec.sandboxSession === "string" && spec.sandboxSession !== ""
      && typeof spec.container === "string" && spec.container !== "") {
      const workspace = typeof spec.sandboxWorkspace === "string" && spec.sandboxWorkspace !== ""
        ? spec.sandboxWorkspace
        : this.deps.config.workspaceRoot
      const requested = typeof spec.workdir === "string" && spec.workdir !== "" ? spec.workdir : spec.cwd
      return { ...filled, cwd: requested ?? this.deps.paths.containerRoot(workspace) }
    }
    const session = resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    // The shipped shell tools name the directory `workdir`; `cwd` is kept for
    // direct callers of this executor.
    const requested = spec.workdir ?? spec.cwd
    const cwd = requested === undefined
      ? this.deps.paths.containerRoot(session.workspace)
      : this.deps.paths.toContainer(requested, session.workspace)
    return {
      ...filled,
      cwd,
      container: session.container,
      sandboxSession: session.sessionId,
      sandboxWorkspace: session.workspace,
      sandboxShared: session.shared,
    }
  }

  /** Run one command in the conversation's container. */
  async execute(spec: ShellExecSpec): Promise<ShellProcess> {
    const config = this.deps.config
    const resolved = this.resolve(spec)
    const sessionId = String(resolved.sandboxSession ?? "")
    const container = String(resolved.container ?? "")
    if (sessionId === "" || container === "") {
      throw new SandboxSessionError(
        "this shell request names no sandbox conversation; resolve it through this executor before executing it",
        "NO_SESSION",
      )
    }
    const target: SandboxTarget = {
      sessionId,
      container,
      workspace: String(resolved.sandboxWorkspace ?? config.workspaceRoot),
      shared: resolved.sandboxShared === true,
    }
    const timeoutMs = Math.max(0, Math.min(resolved.timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
    // The app's Pwsh tool hands PowerShell text to this seam; answer it with
    // one clear redirect before a container is even provisioned for a command
    // that cannot run there.
    if (config.pwshGuard && looksLikePowerShell(String(resolved.command ?? ""))) {
      return rejectedProcess(POWERSHELL_REJECTION, timeoutMs, {
        container: target.container,
        image: config.image.get(),
        workspace: target.workspace,
        rejected: "powershell",
      }) as unknown as ShellProcess
    }

    await this.deps.provisioner.ensure(target, { signal: resolved.signal })

    const maxOutputBytes = resolved.maxOutputBytes ?? config.maxOutputBytes.get()
    const onExpiry = resolved.onExpiry ?? "kill"

    const handle = this.deps.subprocess.spawn({
      argv: [...(await this.shellArgvFor(target)), String(resolved.command)],
      cwd: resolved.cwd,
      env: resolved.env,
      graceMs: resolved.graceMs ?? config.graceMs.get(),
      signal: resolved.signal,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: maxOutputBytes },
        stderr: { maxBytes: maxOutputBytes },
      },
    })

    let timedOut = false
    let aborted = false
    let providerFailure: { error: unknown; note: string } | undefined
    // One cursor per stream: stdout and stderr are independent byte streams, so
    // a shared cursor re-emits whatever the other stream already returned.
    let stdoutOffset = 0
    let stderrOffset = 0

    const timer = timeoutMs > 0 && onExpiry === "kill"
      ? setTimeout(() => {
        timedOut = true
        handle.terminate()
      }, timeoutMs)
      : undefined
    if (timer) timer.unref?.()

    // The shipped job-output pump reads `observed.stderr` directly; when the
    // provider failed before reporting an outcome, the failure note rides that
    // stream in place of the process's own stderr, exactly as the local
    // executor presents it.
    const observedStderr = {
      readFrom: (fromByte: number) => {
        if (providerFailure !== undefined) {
          const note = Buffer.from(providerFailure.note, "utf8")
          return {
            text: note.subarray(Math.min(fromByte, note.length)).toString("utf8"),
            nextOffset: note.length,
            lossy: false,
          }
        }
        return handle.collected.stderr?.readFrom(fromByte) ?? { text: "", nextOffset: fromByte, lossy: false }
      },
      get text() {
        return handle.collected.stderr?.text ?? ""
      },
      get lossy() {
        return handle.collected.stderr?.lossy === true
      },
      get bytes() {
        return handle.collected.stderr?.bytes ?? 0
      },
    }

    const proc = {
      status: "running" as "running" | "completed" | "killed",
      exitCode: null as number | null,
      signal: null as string | null,
      observed: {
        stdout: handle.collected.stdout ?? { readFrom: (fromByte: number) => ({ text: "", nextOffset: fromByte, lossy: false }) },
        stderr: observedStderr,
      },
      // Settles when the process closes; never rejects. A launch failure is
      // recorded as a killed status with the note surfaced on `observed.stderr`
      // and re-thrown by `result()`, mirroring the local executor.
      done: Promise.resolve().then(() => handle.done).then(
        (outcome) => {
          if (timer) clearTimeout(timer)
          if (proc.status === "running") {
            proc.status = aborted || outcome.killed === true || outcome.signal !== null ? "killed" : "completed"
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        },
        (error: unknown) => {
          if (timer) clearTimeout(timer)
          proc.status = "killed"
          providerFailure = { error, note: `subprocess failed before reporting an outcome: ${String(error)}` }
        },
      ),
      readOutput: () => {
        const out = handle.collected.stdout?.readFrom(stdoutOffset)
        const err = handle.collected.stderr?.readFrom(stderrOffset)
        if (out !== undefined) stdoutOffset = out.nextOffset
        if (err !== undefined) stderrOffset = err.nextOffset
        const outText = out?.text ?? ""
        const errText = err?.text ?? ""
        const separator = outText.length > 0 && !outText.endsWith("\n") ? "\n" : ""
        return {
          delta: outText + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
          lossy: out?.lossy === true || err?.lossy === true,
        }
      },
      kill: () => {
        if (proc.status !== "running") return false
        proc.status = "killed"
        handle.terminate()
        return true
      },
      result: () => proc.done.then(() => {
        if (providerFailure !== undefined) throw providerFailure.error
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          // Always booleans, never omitted: the shell tools copy these onto
          // the tool result, and a nested `undefined` fails the tool output's
          // lossless-JSON validation ("value is not lossless JSON").
          timedOut,
          aborted,
          timeoutMs,
          stdout: { text: stdout?.text ?? "", truncated: stdout?.lossy === true },
          stderr: { text: stderr?.text ?? "", truncated: stderr?.lossy === true },
        }
      }),
      get closed() {
        return proc.status !== "running"
      },
      details: {
        container: target.container,
        image: config.image.get(),
        workspace: target.workspace,
      },
    }

    // A background handle nobody awaits must not become an unhandled rejection.
    proc.done.catch(() => undefined)

    if (resolved.signal) {
      resolved.signal.addEventListener("abort", () => {
        aborted = true
        handle.terminate()
      }, { once: true })
    }

    return proc as unknown as ShellProcess
  }

  /**
   * The shell argv for one container: the configured `shellArgv` unless the
   * container has bash, in which case bash. Debian images (node:22) ship
   * `/bin/sh` as dash, which fails on ordinary bash syntax (`${arr[@]}`,
   * `[[ ... ]]`) with "Bad substitution"; bash removes that class of failure.
   * Alpine images have no bash, so the configured argv stays. Probed once per
   * container name and cached; a container recreated under the same name
   * reuses the answer, which is safe because the image rarely changes.
   */
  private async shellArgvFor(target: SandboxTarget): Promise<string[]> {
    const cached = this.shellArgvCache.get(target.container)
    if (cached !== undefined) return cached
    let argv = this.deps.config.shellArgv
    try {
      const probe = await this.deps.transport.exec([
        "exec",
        target.container,
        "sh",
        "-c",
        "command -v bash >/dev/null 2>&1 && echo yes || echo no",
      ])
      if (probe.stdout.toString().trim() === "yes") argv = ["/bin/bash", "-lc"]
    } catch {
      // A failed probe leaves the configured argv in play; the command itself
      // will report any real problem.
    }
    this.shellArgvCache.set(target.container, argv)
    return argv
  }

  /** The isolation is a Docker container, not a same-world restriction. */
  override get sandboxMode(): string | undefined {
    return "docker-container"
  }
}

export type { ShellExecutor }
