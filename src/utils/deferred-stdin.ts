const BUFFER_CAP_BYTES = 8 * 1024 * 1024

interface DeferredStream {
  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean
  end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): DeferredStream
  on(event: string, listener: () => void): DeferredStream
  once(event: string, listener: () => void): DeferredStream
  off(event: string, listener: () => void): DeferredStream
  emit(event: string): boolean
  destroy(): DeferredStream
}

interface StdinSink extends NodeJS.WritableStream {
  destroy?(): void
}

export class DeferredStdin {
  private buffered: Buffer[] = []
  private bufferedBytes = 0
  private live: StdinSink | undefined
  private ended = false
  private readonly drainListeners = new Set<() => void>()
  readonly stream: NodeJS.WritableStream

  constructor() {
    const self = this
    const stream: DeferredStream = {
      write(chunk, encodingOrCallback, callback): boolean {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
        if (typeof done === "function") done()
        return self.push(chunk)
      },
      end(chunk, encodingOrCallback, callback): DeferredStream {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
        if (typeof done === "function") done()
        if (chunk !== undefined && chunk !== null) self.push(chunk)
        self.close()
        return stream
      },
      on: (event, listener) => {
        if (event === "drain") self.drainListeners.add(listener)
        return stream
      },
      once: (event, listener) => {
        if (event === "drain") self.drainListeners.add(listener)
        return stream
      },
      off: (event, listener) => {
        if (event === "drain") self.drainListeners.delete(listener)
        return stream
      },
      emit: (event) => {
        if (event !== "drain") return false
        self.fireDrain()
        return self.drainListeners.size > 0
      },
      destroy: () => {
        self.live?.destroy?.()
        return stream
      },
    }
    this.stream = stream as unknown as NodeJS.WritableStream
  }

  private push(chunk: unknown): boolean {
    const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (this.live) return this.live.write(data)
    this.buffered.push(data)
    this.bufferedBytes += data.length
    return this.bufferedBytes < BUFFER_CAP_BYTES
  }

  private fireDrain(): void {
    for (const listener of [...this.drainListeners]) listener()
  }

  private close(): void {
    this.ended = true
    this.live?.end()
  }

  attach(child: NodeJS.WritableStream): void {
    this.live = child
    child.on("drain", () => this.fireDrain())
    for (const chunk of this.buffered.splice(0)) child.write(chunk)
    this.bufferedBytes = 0
    if (this.ended) child.end()
    this.fireDrain()
  }
}
