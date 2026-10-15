import { lstat, open, readFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { FsError, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs"
import { checkSignal, isDirectory, isNotFound, ioError, notFoundError, notRegularFileError, tokenOf } from "../fs-helpers.ts"

export function readArgs(
  optionsOrSignal?: { maxBytes?: number } | AbortSignal,
  maybeSignal?: AbortSignal,
): { maxBytes: number; signal?: AbortSignal } {
  if (optionsOrSignal instanceof AbortSignal) return { maxBytes: 0, signal: optionsOrSignal }
  return { maxBytes: optionsOrSignal?.maxBytes ?? 0, signal: maybeSignal }
}

export async function readCapped(host: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
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

export function mapReadError(target: FsTarget, error: unknown): never {
  if (isNotFound(error)) throw notFoundError("read", target)
  if (isDirectory(error)) throw notRegularFileError("read", target)
  throw ioError("read", target, error)
}

export async function openForRead(host: string, target: FsTarget): Promise<FileHandle> {
  try {
    return await open(host, "r")
  } catch (error) {
    mapReadError(target, error)
  }
}

export interface RawRead {
  bytes: Buffer
  version?: FsVersion
  mtimeMs?: number
  truncated: boolean
}

export async function readHost(host: string, target: FsTarget, maxBytes: number): Promise<RawRead> {
  const capped = await readCapped(host, maxBytes).catch((error: unknown) => mapReadError(target, error))
  const st = await lstat(host).catch(() => undefined)
  return {
    bytes: capped.bytes,
    version: st === undefined ? undefined : tokenOf(st),
    mtimeMs: st?.mtimeMs,
    truncated: capped.truncated,
  }
}

export async function* streamTextFrom(host: string, target: FsTarget, signal?: AbortSignal): AsyncGenerator<string> {
  const opened = await openForRead(host, target)
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

export async function readByteRangeFrom(host: string, target: FsTarget, range: { offset: number; length: number }): Promise<Buffer> {
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
