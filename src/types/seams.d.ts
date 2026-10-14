
declare module "@deepseek-ai/dsh-shell" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export type ShellExpiry = "kill" | "none"

  export interface ShellExecSpec {
    command: string
    workdir?: string
    cwd?: string
    env?: Record<string, string | undefined>
    timeoutMs?: number
    onExpiry?: ShellExpiry
    graceMs?: number
    maxOutputBytes?: number
    dshEnv?: Record<string, string>
    sandboxPolicy?: unknown
    signal?: AbortSignal
    [key: string]: unknown
  }

  export interface ShellStreamResult {
    text: string
    truncated: boolean
    spillPath?: string
  }

  export interface ShellRunResult {
    exitCode: number | null
    signal: string | null
    timedOut?: boolean
    aborted?: boolean
    timeoutMs?: number
    stdout: ShellStreamResult
    stderr: ShellStreamResult
    sandbox?: {
      mode?: string
      denied?: boolean
      enforcement?: string
      [key: string]: unknown
    }
  }

  export interface ShellOutputReader {
    readOutput(): {
      delta: string
      lossy: boolean
    }
  }

  export interface ShellProcess extends ShellOutputReader {
    status: "running" | "completed" | "killed"
    exitCode: number | null
    signal: string | null
    observed: {
      stdout: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
      stderr: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean } }
    }
    done: Promise<void>
    result(): Promise<ShellRunResult>
    kill(reason?: string): boolean
    readonly closed: boolean
    readonly details?: Record<string, unknown>
  }

  export abstract class ShellExecutor extends Service {
    constructor(ctx: Context, name: string)
    abstract resolve(spec: ShellExecSpec): ShellExecSpec
    abstract execute(spec: ShellExecSpec): Promise<ShellProcess>
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

  export interface FsTarget {
    targetKey: FsTargetKey
    displayPath: string
    path?: string
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
    target?: FsTarget
    size?: number
    mtimeMs?: number
    version?: FsVersion
  }

  export type FsWriteIntent =
    | { kind: "replaceIfVersion"; version: FsVersion }
    | { kind: "createIfAbsent" }

  export interface FsWriteOutcome {
    target: FsTarget
    version?: FsVersion
    mtimeMs?: number
    operation: "create" | "update"
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
    offset?: number
    length?: number
    [key: string]: unknown
  }

  export interface FsListOptions {
    maxEntries?: number
    [key: string]: unknown
  }

  export interface FsEdit {
    oldString?: string
    newString?: string
    oldText?: string
    newText?: string
    replaceAll?: boolean
  }

  export abstract class FileSystem extends Service {
    constructor(ctx: Context, name: string)
    abstract resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): FsTarget | Promise<FsTarget>
    abstract stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
    lstat?(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined>
    abstract readText(
      target: FsTarget,
      optionsOrSignal?: { maxBytes?: number } | AbortSignal,
      signal?: AbortSignal,
    ): Promise<string>
    abstract readBytes(
      target: FsTarget,
      signalOrOptions?: AbortSignal | { maxBytes?: number },
      maxBytes?: number,
    ): Promise<Buffer>
    streamText?(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
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
    get sandboxMode(): string | undefined
    processPath?(target: FsTarget): string
    fileUrl?(target: FsTarget): string
    processPathFromHostPath?(hostPath: string): string | undefined
    contains(root: FsTarget, target: FsTarget): boolean
  }
}

declare module "@deepseek-ai/dsh-subprocess" {
  import { Context, Service } from "@deepseek-ai/cordis"

  export interface OutputTail {
    readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean }
    readonly text: string
    readonly lossy: boolean
    readonly bytes: number
  }

  export interface SubprocessSpawnSpec {
    argv: string[]
    cwd?: string
    env?: Record<string, string | undefined>
    stdio?: {
      stdin?: "pipe" | "ignore" | "inherit"
      stdout?: "pipe" | "ignore" | { maxBytes?: number }
      stderr?: "pipe" | "ignore" | { maxBytes?: number }
    }
    graceMs?: number
    signal?: AbortSignal
    [key: string]: unknown
  }

  export interface SubprocessOutcome {
    exitCode: number | null
    signal: string | null
    killed?: boolean
  }

  export interface SubprocessHandle {
    stdin?: NodeJS.WritableStream
    stdout?: NodeJS.ReadableStream
    stderr?: NodeJS.ReadableStream
    collected: {
      stdout?: OutputTail
      stderr?: OutputTail
    }
    done: Promise<SubprocessOutcome>
    terminate(): void
    waitForExit(signal?: AbortSignal): Promise<boolean>
  }

  export abstract class SubprocessRuntime extends Service {
    constructor(ctx: Context, name: string)
    abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
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

  export interface TerminalSendOperation {
    readonly done: Promise<{
      viewport: string
      waitReason: TerminalWaitReason
      sessionStatus: string
      truncated: boolean
    }>
    readonly settled: boolean
    readonly cancelRequested: boolean
    readonly startedAt: number
    readOutput(): { delta: string; truncated: boolean }
  }

  export interface TerminalBackendSession {
    motd?: string
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
