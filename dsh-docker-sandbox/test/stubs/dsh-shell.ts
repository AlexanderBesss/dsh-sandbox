export class ShellError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

export class Service {
  constructor(
    protected ctx: any,
    public readonly name: string,
  ) {}
}

export abstract class ShellExecutor extends Service {
  get sandboxMode(): string | undefined {
    return undefined
  }
}
