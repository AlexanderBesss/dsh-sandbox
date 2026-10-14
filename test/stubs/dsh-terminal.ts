export class TerminalError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

export class Service {
  constructor(
    protected ctx: any,
    public readonly name: string,
  ) {}
}

export abstract class TerminalSessionService extends Service {
  abstract registerBackend(backend: any): void
}
