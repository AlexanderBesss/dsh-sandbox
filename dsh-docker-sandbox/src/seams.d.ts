/**
 * Ambient declarations for the DSH capability seams this plugin implements.
 *
 * The installed app ships these packages without type declarations (the
 * asar payload carries only `lib/*.js`), and the published npm versions are
 * older than the runtime, so the contracts are declared here from the shipped
 * runtime shape. Every declaration below mirrors a call site verified in the
 * installed bundle, not a guess:
 *
 * - `ShellExecutor` / `FileSystem` / `SubprocessRuntime` are cordis `Service`
 *   subclasses that self-register under `shell` / `fs` / `subprocess`.
 * - the `subprocess` spawn spec and handle shape come from
 *   `dsh-tool-fs-search`'s ripgrep runner;
 * - the `fs` primitive shape comes from `dsh-fs`'s exports and the shipped
 *   `dsh-fs-sandbox` provider;
 * - the terminal backend shape comes from `dsh-terminal`'s service and the
 *   shipped `dsh-terminal-bash` backend.
 *
 * Keep this file in sync when the app updates; `pnpm typecheck` is the guard.
 */

/**
 * Services this plugin *reads* from the context (`agents`, `sessions`,
 * `terminals`, `webServer`) are declared in `context.d.ts`, which augments the
 * real cordis module. This file stays a global script so the `declare module`
 * blocks below can stand in for packages the app ships without type
 * declarations.
 */

declare module "@deepseek-ai/dsh-shell" {
  import { Context, Service } from "@deepseek-ai/cordis"

  /** How a foreground/background handle behaves when its deadline expires. */
  export type ShellExpiry = "kill" | "none"

  /** A resolved shell request: what to run, where, and under which budget. */
  export interface ShellExecSpec {
    /** Shell command text, run by the executor's shell. */
    command: string
    /** Working directory in the executor's world; the shipped tools name it `workdir`. */
    workdir?: string
    /** Working directory spelling kept for direct callers of this executor. */
    cwd?: string
    /** Environment layers applied on top of the scrubbed parent environment. */
    env?: Record<string, string | undefined>
    /** Foreground deadline in milliseconds; `resolve` always fills it. */
    timeoutMs?: number
    /** What the handle does when `timeoutMs` expires; `resolve` defaults it to `kill`. */
    onExpiry?: ShellExpiry
    /** Terminate-escalation grace period in milliseconds. */
    graceMs?: number
    /** Maximum retained output bytes per stream before spill/lossy reporting. */
    maxOutputBytes?: number
    /** Harness environment collected by the tool layer; executors may ignore it. */
    dshEnv?: Record<string, string>
    /** Sandbox policy the tool layer hands down; a container sandbox may ignore it. */
    sandboxPolicy?: unknown
    /** Cancellation signal owned by the caller. */
    signal?: AbortSignal
    /** Anything the executor stamped during `resolve`. */
    [key: string]: unknown
  }

  /** One settled stream inside a shell result. */
  export interface ShellStreamResult {
    text: string
    /** True when retained output was truncated to the cap. */
    truncated: boolean
    /** Spill file holding the complete stream, when the provider kept one. */
    spillPath?: string
  }

  /** A settled shell result: per-stream output plus first-cause facts. */
  export interface ShellRunResult {
    /** Exit code, or `null` when killed by a signal. */
    exitCode: number | null
    /** Signal name when killed, otherwise `null`. */
    signal: string | null
    /** True when the deadline expired and the handle was killed. */
    timedOut?: boolean
    /** True when the caller's signal aborted the command. */
    aborted?: boolean
    /** The spec's deadline, echoed back. */
    timeoutMs?: number
    /** Complete stdout as retained by the provider. */
    stdout: ShellStreamResult
    /** Complete stderr as retained by the provider. */
    stderr: ShellStreamResult
    /** Sandbox facts the executor applies, when it sandboxes. */
    sandbox?: {
      mode?: string
      denied?: boolean
      enforcement?: string
      [key: string]: unknown
    }
  }

  /** Incremental output reader for a live shell process. */
  export interface ShellOutputReader {
    /** Consume output not returned by a previous read. */
    readOutput(): {
      delta: string
      lossy: boolean
    }
  }

  /** A published shell process handle. */
  export interface ShellProcess extends ShellOutputReader {
    /** Lifecycle the job registry reads: running, then completed or killed. */
    status: "running" | "completed" | "killed"
    /** Exit code once settled, otherwise `null`. */
    exitCode: number | null
    /** Signal name once killed, otherwise `null`. */
    signal: string | null
    /** Non-consuming stream readers the jobs registry pumps for background output. */
    observed: {
      stdout: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
      stderr: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    }
    /** Settles at process close; never rejects. */
    done: Promise<void>
    /** Await the foreground result; rejects only for infrastructure failures. */
    result(): Promise<ShellRunResult>
    /** Stop the process; false when it had already settled. */
    kill(reason?: string): boolean
    /** True once the process has closed. */
    readonly closed: boolean
    /** Identity of the container/process this handle is bound to, when known. */
    readonly details?: Record<string, unknown>
  }

  /** Abstract shell service; subclasses register as `ctx.shell`. */
  export abstract class ShellExecutor extends Service {
    constructor(ctx: Context, name: string)
    /** Normalize a caller request into an executor spec. */
    abstract resolve(spec: ShellExecSpec): ShellExecSpec
    /** Prepare and publish a process handle. */
    abstract execute(spec: ShellExecSpec): Promise<ShellProcess>
    /** The sandbox mode applied by default, or undefined when not confining. */
    get sandboxMode(): string | undefined
  }

  export const DSH_ENV_PREFIX: string
  export function parseExitStatus(text: string): {
    body: string
    exitCode?: number
    signal?: string
  }
}

declare module "@deepseek-ai/dsh-fs" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export type FsTargetKey = string & { readonly __brand: "FsTargetKey" }
  export type FsVersion = string & { readonly __brand: "FsVersion" }
  export function FsTargetKey(key: string): FsTargetKey
  export function FsVersion(version: string): FsVersion

  /** Error codes the seam recognizes. */
  export type FsErrorCode =
    | "FS_NOT_FOUND"
    | "FS_STALE_VERSION"
    | "FS_AMBIGUOUS_EDIT"
    | "FS_NOT_TEXT"
    | "FS_NOT_OBSERVED"
    | "FS_NOT_REGULAR_FILE"
    | "FS_IO_ERROR"

  export class FsError extends Error {
    constructor(message: string, code: FsErrorCode, options?: { cause?: unknown })
    readonly code: FsErrorCode
  }

  /**
   * A resolved filesystem location in the provider's world. The shipped
   * runtime identifies targets by `targetKey` (the observation policy keys
   * write guards by it, the web file API compares it) and shows `displayPath`
   * to the model and UI.
   */
  export interface FsTarget {
    /** Stable identity key used for caching and policy. */
    targetKey: FsTargetKey
    /** Path shown to the model and the UI. */
    displayPath: string
    /** Provider-native absolute path (this provider's own ride-along). */
    path?: string
    /** Host-native path when the provider can name one, else undefined. */
    hostPath?: string
  }

  export type FsFileType = "file" | "directory" | "symlink" | "other"

  export interface FsInfo {
    type: FsFileType
    size?: number
    /** Last modification time in epoch milliseconds. */
    mtimeMs?: number
    version?: FsVersion
    /** The target this info describes; carried by this provider for its own use. */
    target?: FsTarget
  }

  export interface FsDirEntry {
    name: string
    type: FsFileType
    /** Resolved child target, so a listing can be descended without re-resolving. */
    target?: FsTarget
    size?: number
    mtimeMs?: number
    version?: FsVersion
  }

  /**
   * The write guard the tool layer hands down (produced by
   * `dsh-fs-observation-policy` via the `fs/write-intent` waterfall): replace
   * only if the current version still matches, or create only if the path is
   * still absent.
   */
  export type FsWriteIntent =
    | { kind: "replaceIfVersion"; version: FsVersion }
    | { kind: "createIfAbsent" }

  export interface FsWriteOutcome {
    target: FsTarget
    version?: FsVersion
    mtimeMs?: number
    /** Whether this write created the file or updated an existing one. */
    operation: "create" | "update"
    /** Previous text (bounded diff basis), or null when absent/too large. */
    before: string | null
    /** The text now stored. */
    after: string
  }

  export interface FsEditOutcome {
    target: FsTarget
    version?: FsVersion
    mtimeMs?: number
    /** Text before the edit. */
    before: string
    /** Text after the edit. */
    after: string
    replacements?: number
  }

  export interface FsReadOptions {
    /** Maximum characters (text) or bytes (binary) to return. */
    maxBytes?: number
    /** Newest-relative start for ranged reads. */
    offset?: number
    length?: number
    /** Return the whole file even when large, when the caller opts in. */
    [key: string]: unknown
  }

  export interface FsListOptions {
    maxEntries?: number
    [key: string]: unknown
  }

  /**
   * One literal replacement inside a text file. The shipped tools hand down
   * `oldString`/`newString`; the older `oldText`/`newText` spelling is kept
   * for direct callers.
   */
  export interface FsEdit {
    oldString?: string
    newString?: string
    oldText?: string
    newText?: string
    replaceAll?: boolean
  }

  /** Abstract filesystem service; subclasses register as `ctx.fs`. */
  export abstract class FileSystem extends Service {
    constructor(ctx: Context, name: string)
    abstract resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): FsTarget | Promise<FsTarget>
    /** Absence reads as `undefined`; the shipped consumers branch on it. */
    abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
    /** Stat by path without a resolved target (the web file API). */
    lstat?(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined>
    /** The decoded text, bare: the read tool feeds results into its line window. */
    abstract readText(
      target: FsTarget,
      optionsOrSignal?: { maxBytes?: number } | AbortSignal,
      signal?: AbortSignal,
    ): Promise<string>
    /** Raw bytes; the shipped shape is `(target, signal, maxBytes)`. */
    abstract readBytes(
      target: FsTarget,
      signalOrOptions?: AbortSignal | { maxBytes?: number },
      maxBytes?: number,
    ): Promise<Buffer>
    /** Text as an async iterable of chunks (the read tool's path for large files). */
    streamText?(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
    /** Windowed byte read (the web file API). */
    readByteRange?(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Buffer>
    abstract listDir(
      target: FsTarget,
      optionsOrSignal?: { maxEntries?: number } | AbortSignal,
      signal?: AbortSignal,
    ): Promise<FsDirEntry[]>
    abstract writeText(
      target: FsTarget,
      content: string,
      expected?: FsWriteIntent | FsVersion | null,
      signal?: AbortSignal,
      policy?: unknown,
    ): Promise<FsWriteOutcome>
    abstract editText(
      target: FsTarget,
      edit: FsEdit,
      expected?: { version: FsVersion } | FsVersion | null,
      signal?: AbortSignal,
      policy?: unknown,
    ): Promise<FsEditOutcome>
    abstract watch(
      target: FsTarget,
      changed: () => void,
      signal?: AbortSignal,
    ): Promise<() => Promise<void>>
    /** The sandbox mode applied by default, or undefined when not confining. */
    get sandboxMode(): string | undefined
    /** The host-native path behind a target, when this world maps to the host. */
    processPath?(target: FsTarget): string
    /** A `file:` URL for the target, when the host can name one. */
    fileUrl?(target: FsTarget): string
    /** Map a host-native path to this world's process path, when it is inside it. */
    processPathFromHostPath?(hostPath: string): string | undefined
    /** Whether `target` is `root` itself or below it, by identity key. */
    contains(root: FsTarget, target: FsTarget): boolean
  }
}

declare module "@deepseek-ai/dsh-subprocess" {
  import { Context, Service } from "@deepseek-ai/cordis"

  /** Bounded retained stream with lossy-read facts. */
  export interface OutputTail {
    /**
     * Read from an absolute offset. A collected stream always answers — an
     * empty stream reads as empty text; `undefined` would tell the search
     * provider the command produced no collected output at all.
     */
    readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean }
    /** Convenience view of the whole retained tail. */
    readonly text: string
    /** True when bytes were dropped to stay inside the cap. */
    readonly lossy: boolean
    readonly bytes: number
  }

  export interface SubprocessSpawnSpec {
    /** Executable plus arguments, with no shell layer in between. */
    argv: string[]
    /** Working directory in the provider's world. */
    cwd?: string
    /** Environment for the child. */
    env?: Record<string, string | undefined>
    /** Stream policy: pipes, ignores, and per-stream retention caps. */
    stdio?: {
      stdin?: "pipe" | "ignore" | "inherit"
      stdout?: "pipe" | "ignore" | { maxBytes?: number }
      stderr?: "pipe" | "ignore" | { maxBytes?: number }
    }
    /** Terminate-escalation grace period in milliseconds. */
    graceMs?: number
    /** Cancellation signal owned by the caller. */
    signal?: AbortSignal
    [key: string]: unknown
  }

  export interface SubprocessOutcome {
    exitCode: number | null
    signal: string | null
    /** True when the provider killed the process (deadline or cancellation). */
    killed?: boolean
  }

  export interface SubprocessHandle {
    /** Live stdin, when the spec requested a pipe. */
    stdin?: NodeJS.WritableStream
    /** Live stdout, when the spec requested a pipe. */
    stdout?: NodeJS.ReadableStream
    /** Live stderr, when the spec requested a pipe. */
    stderr?: NodeJS.ReadableStream
    /** Bounded retained output for callers that await instead of streaming. */
    collected: {
      stdout?: OutputTail
      stderr?: OutputTail
    }
    /** Settles with the process outcome; rejects only for launch failures. */
    done: Promise<SubprocessOutcome>
    /** Terminate, escalating after the grace period. */
    terminate(): void
    /** Await a graceful exit; false when escalation was needed. */
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }

  /** Abstract subprocess runtime; subclasses register as `ctx.subprocess`. */
  export abstract class SubprocessRuntime extends Service {
    constructor(ctx: Context, name: string)
    /** Start one process. Synchronous throws report launch failures. */
    abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
    /** Resolve an executable name inside this world, or throw. */
    abstract resolveExecutable?(name: string, cwd?: string): Promise<string>
  }

  export class SubprocessExecutableNotFoundError extends Error {
    constructor(message: string, options?: { cause?: unknown })
  }

  export const DSH_ENV_PREFIX: string
  export const SENSITIVE_ENV_PATTERN: RegExp
  export function scrubbedParentEnv(env?: NodeJS.ProcessEnv): Record<string, string>
}

declare module "@deepseek-ai/dsh-terminal" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export type TerminalSessionId = string & { readonly __brand: "TerminalSessionId" }

  export class TerminalError extends Error {
    constructor(message: string, code: string, options?: { cause?: unknown })
    readonly code: string
  }

  export class TerminalBackendCleanupError extends Error {}

  /** Why a send stopped waiting. */
  export type TerminalWaitReason = "stdin_read" | "inferred_idle" | "timeout" | "session_exit"

  /** One exclusive interactive send. */
  export interface TerminalSendOperation {
    /** Settles with the viewport captured for this send. */
    readonly done: Promise<{
      viewport: string
      waitReason: TerminalWaitReason
      sessionStatus: string
      truncated: boolean
    }>
    readonly settled: boolean
    readonly cancelRequested: boolean
    readonly startedAt: number
    /** Consume output accumulated so far. */
    readOutput(): { delta: string; truncated: boolean }
  }

  /** A live backend session owned by the service. */
  export interface TerminalBackendSession {
    /** Startup output shown before the first send. */
    motd?: string
    /** Host-visible process id, when the backend can name one. */
    pid?: number
    startSend(request: {
      text: string
      submit?: boolean
      signal?: AbortSignal
      timeoutMs?: number
    }): TerminalSendOperation
    read(request?: {
      offset?: number
      lines?: number
    }): Promise<{ text: string; lineBegin: number; lineEnd: number; totalLines?: number; truncated: boolean }>
    signal(name: string): Promise<{ processGroupId?: number }>
    close(reason: string): Promise<void>
  }

  /** One backend implementation for a session type. */
  export interface TerminalBackend {
    /** Session type this backend serves, e.g. `shell`. */
    readonly type: string
    spawn(request: {
      sessionId: TerminalSessionId
      owner: string
      type: string
      name?: string
      cwd?: string
      signal?: AbortSignal
    }): Promise<TerminalBackendSession>
  }

  export abstract class TerminalSessionService extends Service {
    constructor(ctx: Context, name: string)
    abstract registerBackend(backend: TerminalBackend): void
    abstract spawn(owner: string, request: { type: string; name?: string; cwd?: string }, signal?: AbortSignal): Promise<unknown>
    abstract startSend(owner: string, id: TerminalSessionId, request: unknown): TerminalSendOperation
    abstract read(owner: string, id: TerminalSessionId, request?: unknown): Promise<unknown>
    abstract signal(owner: string, id: TerminalSessionId, name: string): Promise<unknown>
    abstract list(owner: string): unknown[]
  }
}
