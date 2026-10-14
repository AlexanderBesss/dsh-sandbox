
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

const DIFF_BASIS_MAX_BYTES = 64_000

const WATCH_DEBOUNCE_MS = 150

const STAT_BATCH = 64

export function endingsAdapted(text: string, oldText: string, newText: string): [string, string] {
  if (oldText === "" || text.includes(oldText)) return [oldText, newText]
  const fileHasCrlf = text.includes("\r\n")
  const oldHasCrlf = oldText.includes("\r\n")
  if (fileHasCrlf && !oldHasCrlf) {
    const crlfOld = oldText.replace(/\r?\n/g, "\r\n")
    if (text.includes(crlfOld)) return [crlfOld, newText.replace(/\r?\n/g, "\r\n")]
  }
  if (!fileHasCrlf && oldHasCrlf) {
    const lfOld = oldText.replace(/\r\n/g, "\n")
    if (text.includes(lfOld)) return [lfOld, newText.replace(/\r\n/g, "\n")]
  }
  return [oldText, newText]
}

export interface FsDeps {
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

export class DockerFileSystem extends FileSystem {
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: FsDeps,
  ) {
    super(ctx, "fs")
  }

  private trySession(): SandboxTarget | undefined {
    try {
      return resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    } catch {
      return undefined
    }
  }

  private targetFor(path: string, cwd?: string): FsTarget {
    const session = this.trySession()
    const anchor = session?.workspace ?? cwd ?? (isWindowsAbsolute(path) ? path : undefined)
    if (anchor === undefined) {
      throw new SandboxSessionError(
        "this call is not running inside a conversation and names no working directory, so its path has no sandbox root",
        "NO_SESSION",
      )
    }
    const joined = cwd !== undefined && !path.startsWith("/") && !isWindowsAbsolute(path) ? `${cwd}/${path}` : path
    const containerPath = this.deps.paths.toContainer(joined, anchor)
    const hostPath = this.deps.paths.toWindows(containerPath, anchor)
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

  override processPath(target: FsTarget): string {
    return this.hostOf(target)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    try {
      return this.targetFor(hostPath).hostPath
    } catch {
      return undefined
    }
  }

  override contains(root: FsTarget, target: FsTarget): boolean {
    const parent = String(root.targetKey)
    const child = String(target.targetKey)
    return child === parent || child.startsWith(`${parent}/`)
  }

  private hostOf(target: FsTarget): string {
    if (typeof target.hostPath === "string" && target.hostPath !== "") return target.hostPath
    const session = this.trySession()
    const mapped = session === undefined ? undefined : this.deps.paths.toWindows(target.path ?? target.displayPath, session.workspace)
    if (mapped === undefined) {
      throw new FsError(`"${target.displayPath}" has no host file behind it; it is outside the sandbox mount`, "FS_IO_ERROR")
    }
    return mapped
  }

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

  override async lstat(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.stat(this.targetFor(path, options?.cwd), signal ?? options?.signal)
  }

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

  private async readCapped(host: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
    if (maxBytes <= 0) {
      const bytes = await readFile(host)
      return { bytes, truncated: false }
    }
    const handle = await open(host, "r")
    try {
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

  private static readArgs(
    optionsOrSignal?: { maxBytes?: number } | AbortSignal,
    maybeSignal?: AbortSignal,
  ): { maxBytes: number; signal?: AbortSignal } {
    if (optionsOrSignal instanceof AbortSignal) return { maxBytes: 0, signal: optionsOrSignal }
    return { maxBytes: optionsOrSignal?.maxBytes ?? 0, signal: maybeSignal }
  }

  async readText(target: FsTarget, optionsOrSignal?: { maxBytes?: number } | AbortSignal, maybeSignal?: AbortSignal): Promise<string> {
    const { maxBytes, signal } = DockerFileSystem.readArgs(optionsOrSignal, maybeSignal)
    const raw = await this.readRaw(target, maxBytes, signal)
    return decodeText(raw.bytes, target)
  }

  async readBytes(
    target: FsTarget,
    signalOrOptions?: AbortSignal | { maxBytes?: number },
    maybeMaxBytesOrSignal?: number | AbortSignal,
  ): Promise<Buffer> {
    let maxBytes = 0
    let signal: AbortSignal | undefined
    if (signalOrOptions instanceof AbortSignal) {
      signal = signalOrOptions
      if (typeof maybeMaxBytesOrSignal === "number") maxBytes = maybeMaxBytesOrSignal
    } else if (signalOrOptions !== undefined) {
      maxBytes = signalOrOptions.maxBytes ?? 0
      if (maybeMaxBytesOrSignal instanceof AbortSignal) signal = maybeMaxBytesOrSignal
    }
    const raw = await this.readRaw(target, maxBytes, signal)
    return raw.bytes
  }

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
    let before: string | null = null
    try {
      const previous = await this.readRaw(target, DIFF_BASIS_MAX_BYTES, signal)
      if (!previous.truncated) before = decodeText(previous.bytes, target)
    } catch {
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
    const rawOld = edit.oldString ?? edit.oldText ?? ""
    const rawNew = edit.newString ?? edit.newText ?? ""
    const [oldText, newText] = endingsAdapted(text, rawOld, rawNew)
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

  override get sandboxMode(): string | undefined {
    return undefined
  }
}
