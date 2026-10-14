import { watch as nodeWatch, type FSWatcher } from "node:fs"
import { lstat } from "node:fs/promises"
import type { FsTarget } from "@deepseek-ai/dsh-fs"
import { ioError } from "../fs-helpers.ts"

const WATCH_DEBOUNCE_MS = 150

export async function watchHost(
  host: string,
  target: FsTarget,
  changed: () => void,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
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
