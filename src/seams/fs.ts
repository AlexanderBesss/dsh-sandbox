import type { Dirent } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  FileSystem,
  FsError,
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
import {
  checkSignal,
  decodeText,
  errnoCode,
  type FileStat,
  ioError,
  isNotFound,
  notFoundError,
  tokenOf,
  typeOf,
  typeOfDirent,
} from "./fs-helpers.ts"
import { childTarget, fsHostOf, fsHostPath, fsTargetFor, type FsDeps, type HostRealpath } from "./fs/targets.ts"
import { readArgs, readByteRangeFrom, readHost, streamTextFrom } from "./fs/read.ts"
import { applyEdit } from "./fs/edit.ts"
import { guardToken, writeHost } from "./fs/write.ts"
import { watchHost } from "./fs/watch.ts"

export { endingsAdapted } from "./fs/edit.ts"
export type { FsDeps, HostRealpath }

const DIFF_BASIS_MAX_BYTES = 64_000

const STAT_BATCH = 64

export class DockerFileSystem extends FileSystem {
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: FsDeps,
  ) {
    super(ctx, "fs")
  }

  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): FsTarget {
    return fsTargetFor(this.ctx, this.deps, path, options?.cwd)
  }

  override processPath(target: FsTarget): string {
    return this.lexicalHost(target)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    try {
      return fsTargetFor(this.ctx, this.deps, hostPath).hostPath
    } catch {
      return undefined
    }
  }

  override contains(root: FsTarget, target: FsTarget): boolean {
    const parent = String(root.targetKey)
    const child = String(target.targetKey)
    return child === parent || child.startsWith(`${parent}/`)
  }

  private lexicalHost(target: FsTarget): string {
    return fsHostPath(this.ctx, this.deps, target)
  }

  private async hostOf(target: FsTarget): Promise<string> {
    return fsHostOf(this.ctx, this.deps, target)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    checkSignal(signal)
    // Containment is enforced on the resolved path, but the metadata comes from the lexical path:
    // an in-mount symlink has to report as a symlink, the way listDir already reports it.
    await this.hostOf(target)
    let st: FileStat
    try {
      st = await lstat(this.lexicalHost(target))
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw ioError("stat", target, error)
    }
    return { target, type: typeOf(st), size: st.size, mtimeMs: st.mtimeMs, version: tokenOf(st) }
  }

  override async lstat(path: string, options?: { cwd?: string; signal?: AbortSignal }, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.stat(fsTargetFor(this.ctx, this.deps, path, options?.cwd), signal ?? options?.signal)
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
    const host = await this.hostOf(target)
    let dirents: Dirent[]
    try {
      dirents = await readdir(host, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) throw notFoundError("list", target)
      if (errnoCode(error) === "ENOTDIR") throw new FsError(`"${target.displayPath}" is not a directory`, "FS_IO_ERROR")
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
      return {
        name: entry.name,
        type: st === undefined ? typeOfDirent(entry) : typeOf(st),
        target: childTarget(target, entry.name),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
      }
    })
  }

  private async readRaw(target: FsTarget, maxBytes: number, signal?: AbortSignal) {
    checkSignal(signal)
    return readHost(await this.hostOf(target), target, maxBytes)
  }

  async readText(target: FsTarget, optionsOrSignal?: { maxBytes?: number } | AbortSignal, maybeSignal?: AbortSignal): Promise<string> {
    const { maxBytes, signal } = readArgs(optionsOrSignal, maybeSignal)
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
    return Promise.resolve(this.streamFrom(target, signal))
  }

  private async *streamFrom(target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
    checkSignal(signal)
    yield* streamTextFrom(await this.hostOf(target), target, signal)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Buffer> {
    checkSignal(signal)
    return readByteRangeFrom(await this.hostOf(target), target, range)
  }

  private async writeRaw(target: FsTarget, content: string | Buffer, token: string, signal?: AbortSignal): Promise<{ version: FsVersion; created: boolean }> {
    checkSignal(signal)
    return writeHost(await this.hostOf(target), target, content, token, signal)
  }

  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent | FsVersion | null, signal?: AbortSignal): Promise<FsWriteOutcome> {
    let before: string | null = null
    try {
      const previous = await this.readRaw(target, DIFF_BASIS_MAX_BYTES, signal)
      if (!previous.truncated) before = decodeText(previous.bytes, target)
    } catch {
    }
    const outcome = await this.writeRaw(target, content, guardToken(expected), signal)
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
    const { next, replacements } = applyEdit(text, edit, target)
    const outcome = await this.writeRaw(target, next, current.version ?? "-", signal)
    return {
      target,
      version: outcome.version,
      before: text,
      after: next,
      replacements,
    }
  }

  async watch(target: FsTarget, changed: () => void, signal?: AbortSignal): Promise<() => Promise<void>> {
    checkSignal(signal)
    return watchHost(await this.hostOf(target), target, changed, signal)
  }

  override get sandboxMode(): string | undefined {
    return undefined
  }
}
