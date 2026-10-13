import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { DockerFileSystem } from '../src/seams/fs.ts'
import { PathMapper } from '../src/container/paths.ts'
import { testConfig } from './helpers.ts'
import type { SandboxContext } from '../src/context.ts'

// The host-backed fs is the WINDOWS host fs: these tests drive the real
// Windows→/workspace mapping against real temp files, so they only hold on a
// Windows host. Inside the Linux sandbox container `tmpdir()` is a POSIX path,
// which the PathMapper (Windows-host-only by design) reads as a container path
// outside the mount — honest skips, not failures.
const posix = process.platform !== 'win32'

// A real temp workspace: the host-backed fs is the real host fs, so the
// honest unit test runs against real files. `workspace` is the session's
// Windows cwd; targets come back as container paths.
let workspace = ''
let fs: DockerFileSystem

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-fs-'))
  const ctx = {
    agents: {
      currentInitiator: () => ({ id: 'session-1', session: { id: 'session-1', header: { cwd: workspace } } }),
    },
    sessions: {
      get: (id: string) => (id === 'session-1' ? { id, header: { cwd: workspace } } : undefined),
    },
  } as unknown as SandboxContext
  fs = new DockerFileSystem(ctx, { paths: new PathMapper('workspace', '/workspace'), config: testConfig() })
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const host = (...parts: string[]) => join(workspace, ...parts)

describe.skipIf(posix)('DockerFileSystem.resolve', () => {
  it('stamps the container path and the host path of the same file', () => {
    const target = fs.resolve('src/a.ts')
    expect(target.path).toBe('/workspace/src/a.ts')
    expect(target.displayPath).toBe('/workspace/src/a.ts')
    expect(target.hostPath).toBe(host('src', 'a.ts'))
  })

  it('accepts the Windows and container spellings alike', () => {
    const viaWindows = fs.resolve(`${workspace}\\src\\a.ts`)
    const viaContainer = fs.resolve('/workspace/src/a.ts')
    expect(viaWindows.targetKey).toBe(viaContainer.targetKey)
  })

  it('anchors on an explicit cwd when the caller names one (the web file API)', () => {
    const target = fs.resolve('notes.md', { cwd: workspace })
    expect(target.path).toBe('/workspace/notes.md')
  })

  it('maps a host path back into this world', () => {
    // The shipped gateway contract: `processPathFromHostPath` answers with the
    // process path (a string), and `processPath(resolve(mapped))` round-trips.
    const mapped = fs.processPathFromHostPath(host('src', 'a.ts'))
    expect(mapped).toBe(host('src', 'a.ts'))
    expect(fs.processPath(fs.resolve(mapped!))).toBe(host('src', 'a.ts'))
    expect(fs.processPathFromHostPath('C:\\Windows\\system32')).toBeUndefined()
  })

  it('contains() follows the identity key', () => {
    const root = fs.resolve('')
    expect(fs.contains(root, fs.resolve('src/a.ts'))).toBe(true)
    const src = fs.resolve('src')
    expect(fs.contains(src, fs.resolve('src/a.ts'))).toBe(true)
    expect(fs.contains(src, fs.resolve('other'))).toBe(false)
  })
})

describe.skipIf(posix)('DockerFileSystem in worktree mode', () => {
  // The session's file tools must land in the session's worktree even though
  // the app passes the session-header root (the main checkout) as `cwd`: the
  // mapper's alias resolves that cwd into the worktree.
  let wtFs: DockerFileSystem
  let main = ''
  let worktree = ''

  beforeAll(async () => {
    main = await mkdtemp(join(tmpdir(), 'dsh-fs-main-'))
    worktree = await mkdtemp(join(tmpdir(), 'dsh-fs-wt-'))
    const entry = {
      sessionId: 'session-1',
      mainWorkspace: main,
      repoRoot: main,
      worktreePath: worktree,
      branch: 'dsh-sbx/session-1',
      createdAt: 0,
      hostGitDir: `${main}/.git/worktrees/session-1`,
      gitConfig: {},
    }
    const paths = new PathMapper('workspace', '/workspace')
    paths.registerExtraMount(worktree, {
      mount: { hostPath: `${main}\\.git`, containerPath: PathMapper.windowsToDrive(`${main}\\.git`) },
      containerGitDir: PathMapper.windowsToDrive(`${main}\\.git\\worktrees\\session-1`),
      gitConfig: {},
      aliasHost: main,
    })
    const ctx = {
      agents: {
        currentInitiator: () => ({ id: 'session-1', session: { id: 'session-1', header: { cwd: main } } }),
      },
      sessions: {
        get: (id: string) => (id === 'session-1' ? { id, header: { cwd: main } } : undefined),
      },
    } as unknown as SandboxContext
    wtFs = new DockerFileSystem(ctx, {
      paths,
      config: testConfig(),
      worktrees: { ensure: () => entry, lookup: () => entry } as never,
    })
  })

  afterAll(async () => {
    await rm(main, { recursive: true, force: true })
    await rm(worktree, { recursive: true, force: true })
  })

  it('routes a cwd-anchored write into the worktree, not the main checkout', () => {
    const target = wtFs.resolve('package.json', { cwd: main })
    expect(target.path).toBe('/workspace/package.json')
    expect(target.hostPath).toBe(join(worktree, 'package.json'))
  })

  it('routes the main checkout spelled absolutely into the worktree', () => {
    const viaMain = wtFs.resolve(`${main}\\package.json`)
    const viaWorktree = wtFs.resolve(`${worktree}\\package.json`)
    expect(viaMain.targetKey).toBe(viaWorktree.targetKey)
    expect(viaMain.hostPath).toBe(join(worktree, 'package.json'))
  })

  it('still writes the main checkout directly when worktree mode is off', async () => {
    // The same fs without a worktree entry: session.workspace is the main
    // checkout, so edits land there (the documented shared-workspace mode).
    const plain = new PathMapper('workspace', '/workspace')
    const ctx = {
      agents: {
        currentInitiator: () => ({ id: 'session-1', session: { id: 'session-1', header: { cwd: main } } }),
      },
      sessions: { get: (id: string) => ({ id, header: { cwd: main } }) },
    } as unknown as SandboxContext
    const offFs = new DockerFileSystem(ctx, { paths: plain, config: testConfig() })
    const target = offFs.resolve('package.json', { cwd: main })
    expect(target.hostPath).toBe(join(main, 'package.json'))
  })
})

describe.skipIf(posix)('DockerFileSystem reads and writes', () => {
  it('stats a real file with a size and a version token', async () => {
    await mkdir(host('src'), { recursive: true })
    await writeFile(host('src', 'a.ts'), 'hello')
    const info = await fs.stat(fs.resolve('src/a.ts'))
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(5)
    expect(info?.version).toMatch(/^\d+-\d+$/)
  })

  it('reports absence as undefined (the shipped consumers branch on it)', async () => {
    expect(await fs.stat(fs.resolve('missing.ts'))).toBeUndefined()
  })

  it('round-trips text through the host filesystem', async () => {
    const target = fs.resolve('notes/readme.md')
    const written = await fs.writeText(target, '# hi\n')
    expect(written.operation).toBe('create')
    expect(await fs.readText(target)).toBe('# hi\n')
    const info = await fs.stat(target)
    expect(info?.version).toBe(written.version)
  })

  it('refuses a write that carries a stale version', async () => {
    const target = fs.resolve('guarded.txt')
    const first = await fs.writeText(target, 'one')
    await fs.writeText(target, 'two-and-longer', null) // unconditional: allowed, changes the token
    try {
      await fs.writeText(target, 'three', first.version ?? undefined)
      expect.unreachable('the stale write should have been refused')
    } catch (error) {
      expect((error as FsError).code).toBe('FS_STALE_VERSION')
    }
  })

  it('refuses to create over an existing file without observing it', async () => {
    const target = fs.resolve('exists.txt')
    await fs.writeText(target, 'one')
    try {
      await fs.writeText(target, 'two', { kind: 'createIfAbsent' })
      expect.unreachable('the create should have been refused')
    } catch (error) {
      expect((error as FsError).code).toBe('FS_NOT_OBSERVED')
    }
  })

  it('edits in place and reports the replacement count', async () => {
    const target = fs.resolve('edit.txt')
    await fs.writeText(target, 'alpha beta alpha')
    const outcome = await fs.editText(target, { oldString: 'alpha', newString: 'gamma', replaceAll: true })
    expect(outcome.replacements).toBe(2)
    expect(await fs.readText(target)).toBe('gamma beta gamma')
    await expect(fs.editText(target, { oldString: 'nope', newString: 'x' })).rejects.toThrowError(/not found/)
  })

  it('inserts replacement text verbatim, $ sequences and all', async () => {
    // `String.replace` reads `$&`, `$1`, `` $` ``… inside a string replacement,
    // which silently rewrites new text carrying a shell `$$` or a regex
    // backreference. The single-match path must insert the text as given.
    const target = fs.resolve('dollar.txt')
    await fs.writeText(target, 'echo hello')
    const wanted = 'echo $$ $& $` $1'
    const outcome = await fs.editText(target, { oldString: 'hello', newString: wanted })
    expect(outcome.after).toBe(`echo ${wanted}`)
    expect(await fs.readText(target)).toBe(`echo ${wanted}`)
  })

  it('caps a read at maxBytes when a direct caller asks for one', async () => {
    const target = fs.resolve('long.txt')
    await fs.writeText(target, 'x'.repeat(5000))
    expect(await fs.readText(target, { maxBytes: 10 })).toBe('x'.repeat(10))
  })

  it('honours maxEntries when listing', async () => {
    const entries = await fs.listDir(fs.resolve(''), { maxEntries: 2 })
    expect(entries).toHaveLength(2)
  })

  it('lists a directory with types and child targets', async () => {
    const entries = await fs.listDir(fs.resolve(''))
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('src')
    expect(names).toContain('notes')
    expect(entries.find((entry) => entry.name === 'src')?.type).toBe('directory')
    expect(entries.find((entry) => entry.name === 'edit.txt')?.type).toBe('file')
    const child = entries.find((entry) => entry.name === 'src')?.target
    expect(child?.displayPath).toBe('/workspace/src')
  })
})

describe.skipIf(posix)('DockerFileSystem.watch', () => {
  it('notifies when the watched file changes', async () => {
    const target = fs.resolve('watched.txt')
    await fs.writeText(target, 'first')
    let fired = false
    const stop = await fs.watch(target, () => {
      fired = true
    })
    try {
      await fs.writeText(target, 'second')
      for (let attempt = 0; attempt < 40 && !fired; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(fired).toBe(true)
    } finally {
      await stop()
    }
  })
})
