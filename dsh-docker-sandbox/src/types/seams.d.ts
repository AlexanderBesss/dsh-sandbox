// ambient shims for untyped app packages; each declaration mirrors a verified call site — keep in sync when the app updates. No top-level imports: must stay a global script.

declare module "@deepseek-ai/dsh-shell" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export type ShellExpiry = "kill" | "none"

  export interface ShellExecSpec {
    command: string
    // the shipped tools name it `workdir`
    workdir?: string
    // kept for direct callers of this executor
    cwd?: string
    // layered on top of the scrubbed parent environment
    env?: Record<string, string | undefined>
    // `resolve` always fills it
    timeoutMs?: number
    // `resolve` defaults it to `kill`
    onExpiry?: ShellExpiry
    graceMs?: number
    // per stream, before spill/lossy reporting
    maxOutputBytes?: number
    // collected by the tool layer; executors may ignore it
    dshEnv?: Record<string, string>
    // handed down by the tool layer; a container sandbox may ignore it
    sandboxPolicy?: unknown
    signal?: AbortSignal
    // what the executor stamped during `resolve`
    [key: string]: unknown
  }

  export interface ShellStreamResult {
    text: string
    // retained output was cut to the cap
    truncated: boolean
    // full stream, when the provider kept a spill file
    spillPath?: string
  }

  export interface ShellRunResult {
    // null when killed by a signal
    exitCode: number | null
    signal: string | null
    timedOut?: boolean
    aborted?: boolean
    // the spec's deadline, echoed back
    timeoutMs?: number
    stdout: ShellStreamResult
    stderr: ShellStreamResult
    // present only when the executor sandboxes
    sandbox?: {
      mode?: string
      denied?: boolean
      enforcement?: string
      [key: string]: unknown
    }
  }

  export interface ShellOutputReader {
    // output not returned by a previous read
    readOutput(): {
      delta: string
      lossy: boolean
    }
  }

  export interface ShellProcess extends ShellOutputReader {
    // the lifecycle the job registry reads
    status: "running" | "completed" | "killed"
    exitCode: number | null
    signal: string | null
    // non-consuming readers the jobs registry pumps for background output
    observed: {
      stdout: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
      stderr: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    }
    // settles at process close; never rejects
    done: Promise<void>
    // rejects only for infrastructure failures
    result(): Promise<ShellRunResult>
    // false when the process had already settled
    kill(reason?: string): boolean
    readonly closed: boolean
    readonly details?: Record<string, unknown>
  }

  // subclasses register as `ctx.shell`
  export abstract class ShellExecutor extends Service {
    constructor(ctx: Context, name: string)
    // turns a caller request into an executor spec
    abstract resolve(spec: ShellExecSpec): ShellExecSpec
    abstract execute(spec: ShellExecSpec): Promise<ShellProcess>
    // undefined when not confining
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

  // the shipped runtime keys write guards and the web file API on targetKey; displayPath is what the model and UI see
  export interface FsTarget {
    targetKey: FsTargetKey
    displayPath: string
    path?: string
    // undefined when the provider cannot name a host-native path
    hostPath?: string
  }

  export type FsFileType = "file" | "directory" | "symlink" | "other"

  export interface FsInfo {
    type: FsFileType
    size?: number
    mtimeMs?: number
    version?: FsVersion
    target?: FsTarget
  }

  export interface FsDirEntry {
    name: string
    type: FsFileType
    // lets a listing be descended without re-resolving
    target?: FsTarget
    size?: number
    mtimeMs?: number
    version?: FsVersion
  }

  // handed down by the tool layer (`dsh-fs-observation-policy` via the `fs/write-intent` waterfall): replace only on a matching version, create only when absent
  export type FsWriteIntent =
    | { kind: "replaceIfVersion"; version: FsVersion }
    | { kind: "createIfAbsent" }

  export interface FsWriteOutcome {
    target: FsTarget
    version?: FsVersion
    mtimeMs?: number
    operation: "create" | "update"
    // bounded diff basis; null when absent or too large
    before: string | null
    after: string
  }

  export interface FsEditOutcome {
    target: FsTarget
    version?: FsVersion
    mtimeMs?: number
    before: string
    after: string
    replacements?: number
  }

  export interface FsReadOptions {
    maxBytes?: number
    // ranged reads count from the newest end
    offset?: number
    length?: number
    [key: string]: unknown
  }

  export interface FsListOptions {
    maxEntries?: number
    [key: string]: unknown
  }

  // shipped tools hand down oldString/newString; the oldText/newText spelling is kept for direct callers
  export interface FsEdit {
    oldString?: string
    newString?: string
    oldText?: string
    newText?: string
    replaceAll?: boolean
  }

  // subclasses register as `ctx.fs`
  export abstract class FileSystem extends Service {
    constructor(ctx: Context, name: string)
    abstract resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): FsTarget | Promise<FsTarget>
    // absence reads as `undefined`; the shipped consumers branch on it
    abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
    // used by the web file API
    lstat?(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined>
    // bare decoded text: the read tool feeds it into its line window
    abstract readText(
      target: FsTarget,
      optionsOrSignal?: { maxBytes?: number } | AbortSignal,
      signal?: AbortSignal,
    ): Promise<string>
    // the shipped argument shape is `(target, signal, maxBytes)`
    abstract readBytes(
      target: FsTarget,
      signalOrOptions?: AbortSignal | { maxBytes?: number },
      maxBytes?: number,
    ): Promise<Buffer>
    // the read tool's path for large files
    streamText?(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
    // used by the web file API
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
    // undefined when not confining
    get sandboxMode(): string | undefined
    // when this world maps to the host
    processPath?(target: FsTarget): string
    fileUrl?(target: FsTarget): string
    // only when the host path is inside this world
    processPathFromHostPath?(hostPath: string): string | undefined
    // compared by identity key
    contains(root: FsTarget, target: FsTarget): boolean
  }
}

declare module "@deepseek-ai/dsh-subprocess" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export interface OutputTail {
    // the shipped search provider reads an undefined read as "no output streams" — always answer, even when empty
    readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean }
    readonly text: string
    // true when bytes were dropped to stay inside the cap
    readonly lossy: boolean
    readonly bytes: number
  }

  export interface SubprocessSpawnSpec {
    // no shell layer in between
    argv: string[]
    // in the provider's world, not the host
    cwd?: string
    env?: Record<string, string | undefined>
    stdio?: {
      stdin?: "pipe" | "ignore" | "inherit"
      stdout?: "pipe" | "ignore" | { maxBytes?: number }
      stderr?: "pipe" | "ignore" | { maxBytes?: number }
    }
    // grace before terminate escalates
    graceMs?: number
    // owned by the caller
    signal?: AbortSignal
    [key: string]: unknown
  }

  export interface SubprocessOutcome {
    exitCode: number | null
    signal: string | null
    // set when the provider killed it (deadline or cancellation)
    killed?: boolean
  }

  export interface SubprocessHandle {
    // present only when the spec requested a pipe
    stdin?: NodeJS.WritableStream
    stdout?: NodeJS.ReadableStream
    stderr?: NodeJS.ReadableStream
    // for callers that await instead of streaming
    collected: {
      stdout?: OutputTail
      stderr?: OutputTail
    }
    // rejects only for launch failures
    done: Promise<SubprocessOutcome>
    // escalates after the grace period
    terminate(): void
    // false when escalation was needed
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }

  // subclasses register as `ctx.subprocess`
  export abstract class SubprocessRuntime extends Service {
    constructor(ctx: Context, name: string)
    // launch failures throw synchronously
    abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
    // throws when unresolvable
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

  export type TerminalWaitReason = "stdin_read" | "inferred_idle" | "timeout" | "session_exit"

  // one send at a time
  export interface TerminalSendOperation {
    // settles with the viewport captured for this send
    readonly done: Promise<{
      viewport: string
      waitReason: TerminalWaitReason
      sessionStatus: string
      truncated: boolean
    }>
    readonly settled: boolean
    readonly cancelRequested: boolean
    readonly startedAt: number
    // consuming read of the output accumulated so far
    readOutput(): { delta: string; truncated: boolean }
  }

  export interface TerminalBackendSession {
    // startup output shown before the first send
    motd?: string
    // host-visible, when the backend can name one
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

  export interface TerminalBackend {
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
