/**
 * Shared pieces of the host-backed filesystem provider.
 *
 * The classifications, version tokens, cancellation check, and error shapes
 * that {@link DockerFileSystem} applies across every operation, kept apart
 * from the seam class so the mapping rules are stated once.
 *
 * @module dsh-docker-sandbox/seams/fs-helpers
 */

import { type Dirent } from "node:fs"
import { FsError, type FsFileType, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs"

/** Decode a UTF-8 buffer, or report that it is not text. */
export function decodeText(buffer: Buffer, target: FsTarget): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    throw new FsError(`"${target.displayPath}" is not valid UTF-8 text`, "FS_NOT_TEXT")
  }
}

/** A stat result, narrowed to what the seam reports. */
export type FileStat = {
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** Map a stat result onto the seam's type enum. */
export function typeOf(st: FileStat): FsFileType {
  if (st.isSymbolicLink()) return "symlink"
  if (st.isDirectory()) return "directory"
  if (st.isFile()) return "file"
  return "other"
}

/**
 * The version token: `<size>-<mtime-seconds>`, the same shape the
 * in-container helpers report, so a token read through one path guards a
 * write through the other.
 */
export function tokenOf(st: { size: number; mtimeMs: number }): FsVersion {
  return `${st.size}-${Math.floor(st.mtimeMs / 1000)}` as FsVersion
}

/** True for the "file is gone" flavor of an fs failure. */
export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

/** True for the "that is a directory" flavor of an fs failure. */
export function isDirectory(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EISDIR"
}

/**
 * Stop early on a cancelled call.
 *
 * The host calls here are short, so this checks between them rather than
 * interrupting one in progress; a caller that walks a large tree still gets
 * away promptly instead of after the whole traversal.
 */
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError("the operation was cancelled", "FS_IO_ERROR")
}

/** Type from a `readdir` dirent, used when the follow-up stat failed. */
export function typeOfDirent(dirent: Dirent): FsFileType {
  if (dirent.isSymbolicLink()) return "symlink"
  if (dirent.isDirectory()) return "directory"
  if (dirent.isFile()) return "file"
  return "other"
}

/** Wrap a host-filesystem failure as the seam's generic IO error. */
export function ioError(action: string, target: FsTarget, error: unknown): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": ${(error as Error).message}`, "FS_IO_ERROR", { cause: error })
}

/** The seam's "the file is not there" error for one action. */
export function notFoundError(action: string, target: FsTarget): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": not found`, "FS_NOT_FOUND")
}

/** The seam's "that is not a regular file" error for one action. */
export function notRegularFileError(action: string, target: FsTarget): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE")
}
