/**
 * `ctx.fs` backed by the host filesystem.
 *
 * The sandbox container bind-mounts the session workspace, so a file
 * operation needs no container at all: the bytes are the same bytes the
 * container sees. That matters beyond speed — opening a chat makes the
 * sidebar file tree call `ctx.fs` (resolve / stat / watch), and a
 * container-backed fs would provision a container just to *look at* a
 * conversation. With the host backing, containers spawn only for actual
 * execution: shell commands, subprocesses, terminal sessions.
 *
 * Targets are still container paths (`/workspace/…`), so what the model
 * sees matches what a shell command in the same chat sees; the Windows path
 * rides along as `hostPath`. Version guarding uses the same `<size>-<mtime>`
 * token the in-container tools compute, so a write carrying a stale token is
 * refused exactly as the local provider refuses one.
 *
 * Watching works too — host `fs.watch` delivers what the request/response
 * container channel never could — which is what the sidebar tree uses to
 * live-update.
 *
 * The shared classifications, tokens, and error shapes live in
 * `fs-helpers.ts`.
 *
 * @module dsh-docker-sandbox/seams/fs
 */

import { watch as nodeWatch, type Dirent, type FSWatcher } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { StringDecoder } from "node:string_decoder"
import {
  FileSystem,
  FsError,
  FsTargetKey,
  type FsDirEntry,
  type FsEdit,
  type FsEditOutcome,
  type FsInfo,
  type FsTarget,
  type FsVersion,
  type FsWriteIntent,
  type FsWriteOutcome,
} from "@deepseek-ai/dsh-fs"
import type { SandboxContext } from "../context.ts"
import type { SandboxConfig } from "../config.ts"
import {
  checkSignal,
  decodeText,
  type FileStat,
  ioError,
  isDirectory,
  isNotFound,
  notFoundError,
  notRegularFileError,
  tokenOf,
  typeOf,
  typeOfDirent,
} from "./fs-helpers.ts"
import { isWindowsAbsolute, PathMapper } from "../container/paths.ts"
import { resolveTarget, SandboxSessionError, type SandboxTarget } from "../container/session.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

/** Cap for the before-image a write outcome carries for the tool's diff card. */
const DIFF_BASIS_MAX_BYTES = 64_000

/** Debounce window for watch notifications; editors save in bursts. */
const WATCH_DEBOUNCE_MS = 150

/** Directory entries stat'd per round trip; enough to pipeline, small enough to stay responsive to cancellation. */
const STAT_BATCH = 64

export interface FsDeps {
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

export class DockerFileSystem extends FileSystem {
  /** The same context, seen with the services this plugin reads. */
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: FsDeps,
  ) {
    super(ctx, "fs")
  }

  /** The initiating conversation, when this call has one. */
  private trySession(): SandboxTarget | undefined {
    try {
      return resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a path to a target. The workspace anchor is the explicit `cwd`
   * when the caller names one (the web file API passes the session-header
   * root), otherwise the initiating conversation's workspace; an absolute
   * path with no conversation anchors on itself, so agentless reads of a
   * named root still map.
   */
  private targetFor(path: string, cwd?: string): FsTarget {
    const session = this.trySession()
    const anchor = cwd ?? session?.workspace ?? (isWindowsAbsolute(path) ? path : undefined)
    if (anchor === undefined) {
      throw new SandboxSessionError(
        "this call is not running inside a conversation and names no working directory, so its path has no sandbox root",
        "NO_SESSION",
      )
    }
    const joined = cwd !== undefined && !path.startsWith("/") && !isWindowsAbsolute(path) ? `${cwd}/${path}` : path
    const containerPath = this.deps.paths.toContainer(joined, anchor)
    const hostPath = this.deps.paths.toWindows(containerPath, anchor)
    // The shipped seam identifies a target by `targetKey` (the observation
    // policy keys write guards by it, the web file API compares it, `contains`
    // derives from it); `path`/`hostPath` are this provider's own ride-alongs.
    return {
      path: containerPath,
      targetKey: FsTargetKey(containerPath),
      displayPath: containerPath,
      ...(hostPath ? { hostPath } : {}),
    }
  }

  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): FsTarget {
    return this.targetFor(path, options?.cwd)
  }

  /** The host-native path behind a target; every fs target is a bind-mounted path. */
  override processPath(target: FsTarget): string {
    return this.hostOf(target)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  /** Map a host-native path into this world, when it is inside the sandbox. */
  override processPathFromHostPath(hostPath: string): string | undefined {
    try {
      return this.targetFor(hostPath).hostPath
    } catch {
      return undefined
    }
  }

  /** Whether `target` is `root` itself or below it, by identity key. */
  override contains(root: FsTarget, target: FsTarget): boolean {
    const parent = String(root.targetKey)
    const child = String(target.targetKey)
    return child === parent || child.startsWith(`${parent}/`)
  }

  /** The Windows file behind a target; every fs target is a bind-mounted path. */
  private hostOf(target: FsTarget): string {
    if (typeof target.hostPath === "string" && target.hostPath !== "") return target.hostPath
    const session = this.trySession()
    const mapped = session === undefined ? undefined : this.deps.paths.toWindows(target.path ?? target.displayPath, session.workspace)
    if (mapped === undefined) {
      throw new FsError(`"${target.displayPath}" has no host file behind it; it is outside the sandbox mount`, "FS_IO_ERROR")
    }
    return mapped
  }

  /**
   * Stat a target. Absence is reported as `undefined`, not as a thrown
   * `FS_NOT_FOUND`: the shipped consumers (the read tool, the web file API)
   * branch on the undefined result and record the absence observation
   * themselves.
   */
  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    checkSignal(signal)
    const host = this.hostOf(target)
    let st: FileStat
    try {
      st = await lstat(host)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw ioError("stat", target, error)
    }
    return { target, type: typeOf(st), size: st.size, mtimeMs: st.mtimeMs, version: tokenOf(st) }
  }

  /** Stat by path without resolving a target first (the web file API). */
  override async lstat(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.stat(this.targetFor(path, options?.cwd), signal ?? options?.signal)
  }

  /**
   * List a directory. The shipped callers pass `(target, signal)`; the older
   * `(target, options, signal)` shape is still accepted. Entries carry the
   * seam's `type` and a child `target` so the sidebar tree can descend.
   */
  async listDir(
    target: FsTarget,
    optionsOrSignal?: { maxEntries?: number } | AbortSignal,
    maybeSignal?: AbortSignal,
  ): Promise<FsDirEntry[]> {
    const isSignal = optionsOrSignal instanceof AbortSignal
    const options = isSignal ? undefined : optionsOrSignal
    const signal = isSignal ? optionsOrSignal : maybeSignal
    checkSignal(signal)
    const host = this.hostOf(target)
    let dirents: Dirent[]
    try {
      dirents = await readdir(host, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) throw notFoundError("list", target)
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new FsError(`"${target.displayPath}" is not a directory`, "FS_IO_ERROR")
      throw ioError("list", target, error)
    }
    const limit = options?.maxEntries ?? Number.POSITIVE_INFINITY
    const visible = dirents.slice(0, limit)
    // Types come from `lstat`, because the seam reports the link itself rather
    // than whatever a symlink points at. The stats are batched: a directory
    // with thousands of entries would otherwise pay one round trip per entry,
    // strictly in sequence.
    const stats: (FileStat | undefined)[] = []
    for (let start = 0; start < visible.length; start += STAT_BATCH) {
      checkSignal(signal)
      const batch = visible.slice(start, start + STAT_BATCH)
      stats.push(...await Promise.all(batch.map((entry) => lstat(join(host, entry.name)).catch(() => undefined))))
    }
    return visible.map((entry, index) => {
      const st = stats[index]
      const childKey = `${String(target.targetKey)}/${entry.name}`
      return {
        name: entry.name,
        type: st === undefined ? typeOfDirent(entry) : typeOf(st),
        target: {
          path: `${target.path}/${entry.name}`,
          targetKey: FsTargetKey(childKey),
          displayPath: `${target.displayPath}/${entry.name}`,
          ...(target.hostPath === undefined ? {} : { hostPath: join(target.hostPath, entry.name) }),
        },
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
      }
    })
  }

  /**
   * Read a file, capped at `maxBytes` (0 means the whole file).
   *
   * The cap is applied while reading rather than after: a bounded read of a
   * large file — the write tool's diff basis, a log tail — must not allocate
   * the whole file first just to throw most of it away.
   */
  private async readCapped(host: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
    if (maxBytes <= 0) {
      const bytes = await readFile(host)
      return { bytes, truncated: false }
    }
    const handle = await open(host, "r")
    try {
      // One byte more than the cap: that is how a truncated read is told apart
      // from a file that happened to end exactly at the limit.
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return { bytes: buffer.subarray(0, Math.min(bytesRead, maxBytes)), truncated: bytesRead > maxBytes }
    } finally {
      await handle.close()
    }
  }

  private async readRaw(target: FsTarget, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Buffer; version?: FsVersion; mtimeMs?: number; truncated: boolean }> {
    checkSignal(signal)
    const host = this.hostOf(target)
    let bytes: Buffer
    let truncated: boolean
    try {
      const capped = await this.readCapped(host, maxBytes)
      bytes = capped.bytes
      truncated = capped.truncated
    } catch (error) {
      if (isNotFound(error)) throw notFoundError("read", target)
      if (isDirectory(error)) throw notRegularFileError("read", target)
      throw ioError("read", target, error)
    }
    const st = await lstat(host).catch(() => undefined)
    return {
      bytes,
      version: st === undefined ? undefined : tokenOf(st),
      mtimeMs: st?.mtimeMs,
      truncated,
    }
  }

  /** Split the shipped `(target, signal)` call from the older `(target, options, signal)` one. */
  private static readArgs(
    optionsOrSignal?: { maxBytes?: number } | AbortSignal,
    maybeSignal?: AbortSignal,
  ): { maxBytes: number; signal?: AbortSignal } {
    if (optionsOrSignal instanceof AbortSignal) return { maxBytes: 0, signal: optionsOrSignal }
    return { maxBytes: optionsOrSignal?.maxBytes ?? 0, signal: maybeSignal }
  }

  /**
   * Read a file as decoded text. The seam returns the bare string — the read
   * tool feeds results straight into its line-window builder — so the version
   * and truncation facts stay internal (`readRaw`) for the write/edit guards.
   */
  async readText(target: FsTarget, optionsOrSignal?: { maxBytes?: number } | AbortSignal, maybeSignal?: AbortSignal): Promise<string> {
    const { maxBytes, signal } = DockerFileSystem.readArgs(optionsOrSignal, maybeSignal)
    const raw = await this.readRaw(target, maxBytes, signal)
    return decodeText(raw.bytes, target)
  }

  /** Read a file as raw bytes; `maxBytes` bounds the complete content. */
  async readBytes(
    target: FsTarget,
    signalOrOptions?: AbortSignal | { maxBytes?: number },
    maybeMaxBytesOrSignal?: number | AbortSignal,
  ): Promise<Buffer> {
    let maxBytes = 0
    let signal: AbortSignal | undefined
    if (signalOrOptions instanceof AbortSignal) {
      // Shipped shape: (target, signal, maxBytes).
      signal = signalOrOptions
      if (typeof maybeMaxBytesOrSignal === "number") maxBytes = maybeMaxBytesOrSignal
    } else if (signalOrOptions !== undefined) {
      // Older shape: (target, options, signal).
      maxBytes = signalOrOptions.maxBytes ?? 0
      if (maybeMaxBytesOrSignal instanceof AbortSignal) signal = maybeMaxBytesOrSignal
    }
    const raw = await this.readRaw(target, maxBytes, signal)
    return raw.bytes
  }

  /**
   * Stream a file as decoded text chunks (the read tool's path for large
   * files). Decoding is incremental with a fatal decoder, so invalid UTF-8
   * fails the same way a whole-file read does; a NUL byte in the leading
   * sample reads as binary, matching the local provider.
   */
  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(this.streamTextInner(target, signal))
  }

  private async *streamTextInner(target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
    checkSignal(signal)
    const host = this.hostOf(target)
    const opened = await open(host, "r").catch((error: unknown) => {
      if (isNotFound(error)) throw notFoundError("read", target)
      if (isDirectory(error)) throw notRegularFileError("read", target)
      throw ioError("read", target, error)
    })
    try {
      const decoder = new StringDecoder("utf8")
      const buffer = Buffer.alloc(64 * 1024)
      let offset = 0
      let sampled = false
      for (;;) {
        checkSignal(signal)
        const { bytesRead } = await opened.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        offset += bytesRead
        const chunk = buffer.subarray(0, bytesRead)
        if (!sampled) {
          sampled = true
          if (chunk.subarray(0, 8 * 1024).includes(0)) {
            throw new FsError(`cannot read "${target.displayPath}": binary file`, "FS_NOT_TEXT")
          }
        }
        try {
          yield decoder.write(chunk)
        } catch {
          throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8`, "FS_NOT_TEXT")
        }
      }
      try {
        const tail = decoder.end()
        if (tail.length > 0) yield tail
      } catch {
        throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8`, "FS_NOT_TEXT")
      }
    } finally {
      await opened.close().catch(() => undefined)
    }
  }

  /** Read the bytes at `[offset, offset + length)` (the web file API's windowed read). */
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Buffer> {
    checkSignal(signal)
    const host = this.hostOf(target)
    const opened = await open(host, "r").catch((error: unknown) => {
      if (isNotFound(error)) throw notFoundError("read", target)
      throw ioError("read", target, error)
    })
    try {
      const buffer = Buffer.alloc(Math.max(0, range.length))
      const { bytesRead } = await opened.read(buffer, 0, buffer.length, Math.max(0, range.offset))
      return buffer.subarray(0, bytesRead)
    } finally {
      await opened.close().catch(() => undefined)
    }
  }

  /**
   * Map the seam's write intent (as handed down by `fs/write-intent`, see
   * `dsh-fs-observation-policy`) onto the guard token. A bare
   * {@link FsVersion} is accepted for direct callers; `undefined`/`null`
   * writes unconditionally.
   */
  private guardToken(expected: FsWriteIntent | FsVersion | null | undefined): string {
    if (expected === null || expected === undefined) return "-"
    if (typeof expected === "string") return expected
    if (expected.kind === "createIfAbsent") return "!"
    if (expected.kind === "replaceIfVersion") return String(expected.version)
    return "-"
  }

  private async writeRaw(target: FsTarget, content: string | Buffer, token: string, signal?: AbortSignal): Promise<{ version: FsVersion; created: boolean }> {
    checkSignal(signal)
    const host = this.hostOf(target)
    const current = await lstat(host).catch(() => undefined)
    if (token === "!" && current !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED")
    }
    if (token !== "-" && token !== "!") {
      if (current === undefined || tokenOf(current) !== token) {
        throw new FsError(`"${target.displayPath}" changed since it was read; re-read it before writing`, "FS_STALE_VERSION")
      }
    }
    checkSignal(signal)
    await mkdir(dirname(host), { recursive: true }).catch(() => undefined)
    try {
      await writeFile(host, content)
    } catch (error) {
      throw ioError("write", target, error)
    }
    const after = await lstat(host).catch(() => undefined)
    return { version: after === undefined ? tokenOf({ size: Buffer.byteLength(content), mtimeMs: Date.now() }) : tokenOf(after), created: current === undefined }
  }

  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent | FsVersion | null, signal?: AbortSignal): Promise<FsWriteOutcome> {
    // The write tool renders its diff card from `before`/`after`; capture a
    // bounded before-image before mutating (the local backend does the same
    // through its `diffBasisMaxBytes`).
    let before: string | null = null
    try {
      const previous = await this.readRaw(target, DIFF_BASIS_MAX_BYTES, signal)
      if (!previous.truncated) before = decodeText(previous.bytes, target)
    } catch {
      // absent or unreadable: no diff basis, same as the local backend
    }
    const outcome = await this.writeRaw(target, content, this.guardToken(expected), signal)
    return {
      target,
      version: outcome.version,
      operation: outcome.created ? "create" : "update",
      before,
      after: content,
    }
  }

  async editText(target: FsTarget, edit: FsEdit, expected?: { version: string } | FsVersion | null, signal?: AbortSignal): Promise<FsEditOutcome> {
    const current = await this.readRaw(target, 0, signal)
    const text = decodeText(current.bytes, target)
    const guard = typeof expected === "string" ? expected : expected?.version
    if (guard !== undefined && guard !== null && current.version !== guard) {
      throw new FsError(`"${target.displayPath}" changed since it was read; re-read it before editing`, "FS_STALE_VERSION")
    }
    // The seam hands down `oldString`/`newString` (dsh-tool-fs, str-replace
    // editor); accept the older `oldText`/`newText` spelling as well.
    const oldText = edit.oldString ?? edit.oldText ?? ""
    const newText = edit.newString ?? edit.newText ?? ""
    const matches = text.split(oldText).length - 1
    if (matches === 0) {
      throw new FsError(`the text to replace was not found in "${target.displayPath}"`, "FS_AMBIGUOUS_EDIT")
    }
    if (matches > 1 && edit.replaceAll !== true) {
      throw new FsError(
        `"${oldText.slice(0, 60)}" appears ${matches} times in "${target.displayPath}"; give more context or set replaceAll`,
        "FS_AMBIGUOUS_EDIT",
      )
    }
    const next = edit.replaceAll === true
      ? text.split(oldText).join(newText)
      // A function replacement, deliberately: `replace` reads `$&`, `$1`, `` $` ``
      // and friends inside a *string* replacement, which would silently corrupt
      // new text containing a shell `$$` or a regex backreference.
      : text.replace(oldText, () => newText)
    const outcome = await this.writeRaw(target, next, current.version ?? "-", signal)
    return {
      target,
      version: outcome.version,
      before: text,
      after: next,
      replacements: edit.replaceAll === true ? matches : 1,
    }
  }

  /**
   * Watch a target through the host filesystem. The bind mount carries these
   * changes into the container, so a shell command sees the same files the
   * tree shows. Recursive for directories, single-file otherwise; bursts are
   * debounced to one notification.
   */
  async watch(target: FsTarget, changed: () => void, signal?: AbortSignal): Promise<() => Promise<void>> {
    checkSignal(signal)
    const host = this.hostOf(target)
    const isDir = await lstat(host).then((st) => st.isDirectory()).catch(() => false)
    let timer: NodeJS.Timeout | undefined
    let closed = false
    const fire = () => {
      if (closed || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (!closed) changed()
      }, WATCH_DEBOUNCE_MS)
      timer.unref?.()
    }
    let watcher: FSWatcher | undefined
    try {
      watcher = nodeWatch(host, { recursive: isDir }, () => fire())
    } catch (error) {
      throw ioError("watch", target, error)
    }
    // A watch error (file deleted under us) reads as one change: callers
    // re-stat and handle absence, which is what they do for any change.
    watcher.on("error", () => fire())
    const onAbort = (): void => {
      void close()
    }
    const close = async (): Promise<void> => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      watcher?.close()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    return close
  }

  /** The container boundary is the isolation; no same-world sandbox mode. */
  override get sandboxMode(): string | undefined {
    return undefined
  }
}
