// buffers writes until attach() connects the child; end() before attach is replayed; past the cap write() reports backpressure

// pre-attach buffer cap: past it, writes report backpressure
const BUFFER_CAP_BYTES = 8 * 1024 * 1024

export class DeferredStdin {
  private buffered: Buffer[] = []
  private bufferedBytes = 0
  private live: NodeJS.WritableStream | undefined
  private ended = false
  private readonly drainListeners = new Set<() => void>()
  readonly stream: NodeJS.WritableStream

  constructor() {
    const self = this
    this.stream = {
      write(chunk: any, encodingOrCallback?: any, callback?: any): boolean {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
        done?.()
        return self.push(chunk)
      },
      end(chunk?: any, encodingOrCallback?: any, callback?: any): any {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
        done?.()
        if (chunk !== undefined && chunk !== null) self.push(chunk)
        self.close()
        return this
      },
      on: (event: string, listener: () => void) => {
        if (event === "drain") self.drainListeners.add(listener)
        return this.stream
      },
      once: (event: string, listener: () => void) => {
        if (event === "drain") self.drainListeners.add(listener)
        return this.stream
      },
      off: (event: string, listener: () => void) => {
        if (event === "drain") self.drainListeners.delete(listener)
        return this.stream
      },
      emit: (event: string) => {
        if (event !== "drain") return false
        self.fireDrain()
        return self.drainListeners.size > 0
      },
      destroy: () => {
        (self.live as { destroy?: () => void } | undefined)?.destroy?.()
        return this.stream
      },
    } as unknown as NodeJS.WritableStream
  }

  private push(chunk: any): boolean {
    const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    // after attach the child's backpressure is the truth, before it the cap is — never a constant true
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
    // a caller held at the cap can resume now that the buffer is gone
    this.fireDrain()
  }
}
