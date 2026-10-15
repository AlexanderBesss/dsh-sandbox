// The abort path covers only aborts that happen after the race starts: an already-aborted
// signal never fires its listener, so the promise wins. Callers that must short-circuit on
// a pre-aborted signal (e.g. Provisioner.awaitProvisioning) check signal.aborted themselves.
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      try {
        resolve(onAbort())
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
