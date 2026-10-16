import { describe, expect, it } from 'vitest'
import { PathMapper, SandboxPathError } from '../src/container/paths.ts'

const WINDOWS = 'F:\\Projects\\dsh-sandbox'
const DRIVE = '/f/Projects/dsh-sandbox'

describe('PathMapper.windowsToDrive', () => {
  it('maps a drive letter to its mount point and flips separators', () => {
    expect(PathMapper.windowsToDrive(WINDOWS)).toBe(DRIVE)
    expect(PathMapper.windowsToDrive(`${WINDOWS}\\src\\a.ts`)).toBe(`${DRIVE}/src/a.ts`)
  })

  it('maps a bare drive root to its mount point', () => {
    expect(PathMapper.windowsToDrive('C:\\')).toBe('/c')
  })

  it('leaves POSIX paths alone', () => {
    expect(PathMapper.windowsToDrive('/workspace/src')).toBe('/workspace/src')
    expect(PathMapper.windowsToDrive(DRIVE)).toBe(DRIVE)
  })
})

describe('PathMapper.driveToWindows', () => {
  it('maps a drive-backed container path back to Windows', () => {
    expect(PathMapper.driveToWindows(`${DRIVE}\\src`)).toBe('F:\\Projects\\dsh-sandbox\\src')
    expect(PathMapper.driveToWindows('/f')).toBe('F:\\')
  })

  it('returns undefined for paths with no Windows equivalent', () => {
    expect(PathMapper.driveToWindows('/workspace')).toBeUndefined()
    expect(PathMapper.driveToWindows('/tmp')).toBeUndefined()
  })

  it('accepts a drive letter in either case', () => {
    expect(PathMapper.driveToWindows('/F/tmp/x')).toBe('F:\\tmp\\x')
  })
})

describe('PathMapper.mountsFor (workspace mode)', () => {
  const mapper = new PathMapper('workspace', '/workspace')

  it('mounts exactly the session workspace at the container workspace', () => {
    expect(mapper.mountsFor(WINDOWS)).toEqual([{ hostPath: WINDOWS, containerPath: '/workspace' }])
  })

  it('rejects a workspace that cannot be bind-mounted', () => {
    expect(() => mapper.mountsFor('/home/me/project')).toThrowError(SandboxPathError)
    expect(() => mapper.mountsFor('/home/me/project')).toThrow(/not a Windows absolute path/)
  })
})

describe('PathMapper.mountsFor (drives mode)', () => {
  const mapper = new PathMapper('drives', '/workspace')

  it('mounts the session drive and C: at their container roots', () => {
    expect(mapper.mountsFor(WINDOWS)).toEqual([
      { hostPath: 'C:\\', containerPath: '/c' },
      { hostPath: 'F:\\', containerPath: '/f' },
    ])
  })
})

describe('PathMapper.toContainer (workspace mode)', () => {
  const mapper = new PathMapper('workspace', '/workspace')

  it('accepts container, drive, Windows, and relative spellings of the same file', () => {
    expect(mapper.toContainer('/workspace/src/a.ts', WINDOWS)).toBe('/workspace/src/a.ts')
    expect(mapper.toContainer(`${DRIVE}/src/a.ts`, WINDOWS)).toBe('/workspace/src/a.ts')
    expect(mapper.toContainer(`${WINDOWS}\\src\\a.ts`, WINDOWS)).toBe('/workspace/src/a.ts')
    expect(mapper.toContainer('src/a.ts', WINDOWS)).toBe('/workspace/src/a.ts')
  })

  it('treats the empty path as the workspace root', () => {
    expect(mapper.toContainer('', WINDOWS)).toBe('/workspace')
    expect(mapper.toContainer('.', WINDOWS)).toBe('/workspace')
  })

  it('collapses . and .. inside the workspace', () => {
    expect(mapper.toContainer('/workspace/src/../docs', WINDOWS)).toBe('/workspace/docs')
  })

  it('rejects an absolute path outside the mount instead of guessing', () => {
    expect(() => mapper.toContainer('/etc/passwd', WINDOWS)).toThrowError(SandboxPathError)
    expect(() => mapper.toContainer('/home/me/other', WINDOWS)).toThrow(/outside the sandbox mount/)
  })

  it('rejects a relative path that walks out of the workspace', () => {
    try {
      mapper.toContainer('../sibling', WINDOWS)
      expect.unreachable('the escape should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxPathError)
      expect((error as SandboxPathError).code).toBe('PATH_OUTSIDE_SANDBOX')
    }
  })

  it('rejects an absolute path whose ".." segments leave the mount', () => {
    expect(() => mapper.toContainer('/workspace/../../etc/passwd', WINDOWS)).toThrow(/outside the sandbox mount/)
    expect(() => mapper.toContainer(`${WINDOWS}\\..\\..\\Windows\\system32`, WINDOWS)).toThrow(/outside the sandbox mount/)
  })
})

describe('PathMapper.toContainer (drives mode)', () => {
  const mapper = new PathMapper('drives', '/workspace')

  it('keeps a drive-backed path at its mounted location', () => {
    expect(mapper.toContainer(`${WINDOWS}\\src\\a.ts`, WINDOWS)).toBe(`${DRIVE}/src/a.ts`)
    expect(mapper.toContainer('/f/tmp/x', WINDOWS)).toBe('/f/tmp/x')
  })

  it('normalises a drive mount written with a capital letter', () => {
    expect(mapper.toContainer('/F/tmp/x', WINDOWS)).toBe('/f/tmp/x')
  })

  it('still rejects a path on no mount at all', () => {
    expect(() => mapper.toContainer('/etc/passwd', WINDOWS)).toThrowError(SandboxPathError)
  })

  it('rejects a drive that was never mounted', () => {
    expect(() => mapper.toContainer('/d/tmp/x', WINDOWS)).toThrow(/outside the sandbox mount/)
    expect(mapper.toWindows('/d/tmp/x', WINDOWS)).toBeUndefined()
  })

  it('rejects a mounted drive path whose ".." segments climb above the drive', () => {
    expect(() => mapper.toContainer('/c/../../Windows/x', WINDOWS)).toThrow(/outside the sandbox mount/)
  })
})

describe('PathMapper.toWindows', () => {
  it('round-trips a container path back to the host view', () => {
    const mapper = new PathMapper('workspace', '/workspace')
    expect(mapper.toWindows('/workspace/src/a.ts', WINDOWS)).toBe(`${WINDOWS}\\src\\a.ts`)
    expect(mapper.toWindows('/etc/passwd', WINDOWS)).toBeUndefined()
  })

  it('reports no host path when the anchor itself is not a Windows path', () => {
    const mapper = new PathMapper('workspace', '/workspace')
    expect(mapper.toWindows('/workspace/src/a.ts', '/workspace')).toBeUndefined()
  })

  it('maps drive-mode paths directly', () => {
    const mapper = new PathMapper('drives', '/workspace')
    expect(mapper.toWindows('/f/tmp/x', WINDOWS)).toBe('F:\\tmp\\x')
  })
})

describe('PathMapper.containerRoot', () => {
  it('is the mount point in workspace mode', () => {
    expect(new PathMapper('workspace', '/workspace').containerRoot(WINDOWS)).toBe('/workspace')
  })

  it('is the session drive root in drives mode', () => {
    expect(new PathMapper('drives', '/workspace').containerRoot(WINDOWS)).toBe('/f')
    expect(new PathMapper('drives', '/workspace').containerRoot()).toBe('/c')
  })
})

describe('extra mounts (worktree mode)', () => {
  const worktree = 'F:\\Projects\\app.worktrees\\session-3'
  const gitHost = 'F:\\Projects\\app\\.git'

  function mapperWithExtra(): PathMapper {
    const mapper = new PathMapper('workspace', '/workspace')
    mapper.registerExtraMount(worktree, {
      mount: { hostPath: gitHost, containerPath: '/f/Projects/app/.git' },
      containerGitDir: '/f/Projects/app/.git/worktrees/session-3',
      gitConfig: {},
    })
    return mapper
  }

  it('mounts the main .git alongside the worktree', () => {
    const mounts = mapperWithExtra().mountsFor(worktree)
    expect(mounts).toHaveLength(2)
    expect(mounts[1]).toEqual({ hostPath: gitHost, containerPath: '/f/Projects/app/.git' })
  })

  it('maps drive-form and Windows forms of gitdir paths into the container', () => {
    const mapper = mapperWithExtra()
    expect(mapper.toContainer('/f/Projects/app/.git/worktrees/session-3/HEAD', worktree))
      .toBe('/f/Projects/app/.git/worktrees/session-3/HEAD')
    expect(mapper.toContainer('F:\\Projects\\app\\.git\\config', worktree))
      .toBe('/f/Projects/app/.git/config')
  })

  it('maps those container paths back to Windows paths', () => {
    expect(mapperWithExtra().toWindows('/f/Projects/app/.git/config', worktree))
      .toBe('F:\\Projects\\app\\.git\\config')
  })

  it('still rejects paths outside both mounts', () => {
    expect(() => mapperWithExtra().toContainer('/f/Projects/other/x', worktree))
      .toThrowError(SandboxPathError)
  })

  it('leaves non-worktree sessions untouched', () => {
    const mapper = mapperWithExtra()
    expect(mapper.mountsFor(WINDOWS)).toHaveLength(1)
    expect(() => mapper.toContainer('/f/Projects/app/.git/config', WINDOWS))
      .toThrowError(SandboxPathError)
  })
})

describe('worktree main-workspace alias', () => {
  const worktree = 'F:\\Projects\\app.worktrees\\session-3'
  const main = 'F:\\Projects\\app'

  function aliasMapper(): PathMapper {
    const mapper = new PathMapper('workspace', '/workspace')
    mapper.registerExtraMount(worktree, {
      mount: { hostPath: `${main}\\.git`, containerPath: '/f/Projects/app/.git' },
      containerGitDir: '/f/Projects/app/.git/worktrees/session-3',
      gitConfig: {},
      aliasHost: main,
    })
    return mapper
  }

  it('resolves the main checkout (the session header cwd) to the container root', () => {
    const mapper = aliasMapper()
    expect(mapper.toContainer(main, worktree)).toBe('/workspace')
    expect(mapper.toContainer('F:\\Projects\\app', worktree)).toBe('/workspace')
    expect(mapper.toContainer('/f/Projects/app', worktree)).toBe('/workspace')
  })

  it('resolves paths under the main checkout into the worktree', () => {
    const mapper = aliasMapper()
    expect(mapper.toContainer('F:\\Projects\\app\\src\\x.ts', worktree)).toBe('/workspace/src/x.ts')
    expect(mapper.toContainer('/f/Projects/app/src', worktree)).toBe('/workspace/src')
  })

  it('still prefers the real .git mount over the alias', () => {
    expect(aliasMapper().toContainer('F:\\Projects\\app\\.git\\config', worktree))
      .toBe('/f/Projects/app/.git/config')
  })

  it('does not alias sibling worktrees or unrelated paths', () => {
    const mapper = aliasMapper()
    expect(() => mapper.toContainer('F:\\Projects\\app.worktrees\\session-9\\x', worktree))
      .toThrowError(SandboxPathError)
    expect(() => mapper.toContainer('F:\\Other\\x', worktree)).toThrowError(SandboxPathError)
  })
})
