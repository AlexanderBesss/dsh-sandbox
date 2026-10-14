import { lstat, mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { FsError, type FsTarget, type FsVersion, type FsWriteIntent } from "@deepseek-ai/dsh-fs"
import { checkSignal, ioError, tokenOf } from "../fs-helpers.ts"

export function guardToken(expected: FsWriteIntent | FsVersion | null | undefined): string {
  if (expected === null || expected === undefined) return "-"
  if (typeof expected === "string") return expected
  if (expected.kind === "createIfAbsent") return "!"
  if (expected.kind === "replaceIfVersion") return String(expected.version)
  return "-"
}

export async function writeHost(
  host: string,
  target: FsTarget,
  content: string | Buffer,
  token: string,
  signal?: AbortSignal,
): Promise<{ version: FsVersion; created: boolean }> {
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
  return {
    version: after === undefined ? tokenOf({ size: Buffer.byteLength(content), mtimeMs: Date.now() }) : tokenOf(after),
    created: current === undefined,
  }
}
