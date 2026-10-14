import { type Dirent } from "node:fs"
import { FsError, type FsFileType, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs"

export function decodeText(buffer: Buffer, target: FsTarget): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    throw new FsError(`"${target.displayPath}" is not valid UTF-8 text`, "FS_NOT_TEXT")
  }
}

export type FileStat = {
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export function typeOf(st: FileStat): FsFileType {
  if (st.isSymbolicLink()) return "symlink"
  if (st.isDirectory()) return "directory"
  if (st.isFile()) return "file"
  return "other"
}

export function tokenOf(st: { size: number; mtimeMs: number }): FsVersion {
  return `${st.size}-${Math.floor(st.mtimeMs / 1000)}` as FsVersion
}

export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

export function isNotFound(error: unknown): boolean {
  return errnoCode(error) === "ENOENT"
}

export function isDirectory(error: unknown): boolean {
  return errnoCode(error) === "EISDIR"
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError("the operation was cancelled", "FS_IO_ERROR")
}

export function typeOfDirent(dirent: Dirent): FsFileType {
  if (dirent.isSymbolicLink()) return "symlink"
  if (dirent.isDirectory()) return "directory"
  if (dirent.isFile()) return "file"
  return "other"
}

export function ioError(action: string, target: FsTarget, error: unknown): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": ${(error as Error).message}`, "FS_IO_ERROR", { cause: error })
}

export function notFoundError(action: string, target: FsTarget): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": not found`, "FS_NOT_FOUND")
}

export function notRegularFileError(action: string, target: FsTarget): FsError {
  return new FsError(`cannot ${action} "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE")
}
