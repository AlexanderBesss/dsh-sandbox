import { describe, expect, it } from 'vitest'
import { DockerTransport, SandboxUnavailableError, isMissingContainerError } from '../src/container/transport.ts'

// fake docker args must not include a bare `inspect`: node parses it as its inspector subcommand
function fakeCli(script: string): DockerTransport {
  return new DockerTransport({ dockerArgv: [process.execPath, '-e', script] })
}

describe('DockerTransport.exec', () => {
  it('returns the exit code and both streams', async () => {
    const result = await fakeCli('process.stdout.write("out");process.stderr.write("err")').exec(['show', 'x'])
    expect(result.code).toBe(0)
    expect(result.stdout.toString()).toBe('out')
    expect(result.stderr.toString()).toBe('err')
  })

  it('bounds each stream independently when capturing', async () => {
    const result = await fakeCli('process.stdout.write("x".repeat(200))')
      .exec(['logs', 'x'], { maxCaptureBytes: 50 })
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(false)
    expect(result.stdout.length).toBeGreaterThanOrEqual(50)
  })

  it('reports a killed child as EXEC_TIMEOUT when a budget was set', async () => {
    await expect(fakeCli('setTimeout(() => {}, 10000)').exec(['wait'], { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'EXEC_TIMEOUT' })
  })

  it('reports a missing CLI as DOCKER_MISSING', async () => {
    const transport = new DockerTransport({ dockerArgv: ['definitely-not-a-real-binary-xyz'] })
    await expect(transport.exec(['version'])).rejects.toMatchObject({ code: 'DOCKER_MISSING' })
  })
})

// classification regexes rot when the CLI rewords: these stderr shapes use its real capitalisation
describe('DockerTransport.docker classification', () => {
  it('classifies an unreachable daemon, matching the CLI capitalisation', async () => {
    const transport = fakeCli(
      'process.stderr.write("Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine. Is the docker daemon running?");process.exit(1)',
    )
    const error = await transport.docker(['ps']).then(() => undefined, (e: unknown) => e as SandboxUnavailableError)
    expect(error).toBeInstanceOf(SandboxUnavailableError)
    expect(error!.code).toBe('DOCKER_UNREACHABLE')
  })

  it('classifies a held container name as NAME_CONFLICT', async () => {
    const transport = fakeCli(
      'process.stderr.write(String.raw`Error response from daemon: Conflict. The container name "/dsh-sbx-x" is already in use by container "deadbeef".`);process.exit(125)',
    )
    const error = await transport.docker(['run', '-d', '--name', 'dsh-sbx-x', 'alpine']).then(() => undefined, (e: unknown) => e as SandboxUnavailableError)
    expect(error!.code).toBe('NAME_CONFLICT')
  })

  it('classifies a gone container so isMissingContainerError recognises it', async () => {
    const transport = fakeCli(
      'process.stderr.write("Error response from daemon: No such container: dsh-sbx-x");process.exit(1)',
    )
    const error = await transport.execInContainer({ container: 'dsh-sbx-x' }, ['true']).then(() => undefined, (e: unknown) => e as unknown)
    expect(isMissingContainerError(error)).toBe(true)
  })

  it('parses dockerJson and rejects non-JSON output', async () => {
    const parsed = await fakeCli('process.stdout.write(JSON.stringify([{ State: { Status: "running" } }]))')
      .dockerJson<[{ State: { Status: string } }]>(['show', 'x'])
    expect(parsed[0]?.State.Status).toBe('running')

    await expect(fakeCli('process.stdout.write("not json")').dockerJson(['show', 'x']))
      .rejects.toMatchObject({ code: 'EXEC_FAILED' })
  })
})
