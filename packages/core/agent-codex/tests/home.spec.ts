import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { secureCodexHome, verifyCodexHome } from '../src/home.ts'

describe('Codex runtime home', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function fixture(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-codex-home-')))
    roots.push(root)
    return root
  }

  it('creates a normal production Custom home below the independently supplied app-data root', async () => {
    const base = await fixture()
    const root = join(base, 'Application Support', 'DS Harness Custom')
    const home = join(root, 'codex-subscription', 'codex-home')
    await secureCodexHome(home, root)
    await expect(verifyCodexHome(home, root)).resolves.toBe(home)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it('creates a normal rehearsal home below the explicit rehearsal root', async () => {
    const root = join(await fixture(), 'rehearsal')
    const dshHome = join(root, 'dsh-home')
    const home = join(dshHome, 'codex-subscription', 'codex-home')
    await secureCodexHome(home, root)
    await expect(verifyCodexHome(home, root)).resolves.toBe(home)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it.each(['external', '.codex'] as const)('rejects a trusted-root symlink to a synthetic %s directory before mutation', async (name) => {
    const base = await fixture()
    const target = join(base, name)
    const linkedRoot = join(base, 'trusted-root-link')
    await mkdir(target)
    await symlink(target, linkedRoot, 'dir')
    await expect(secureCodexHome(join(linkedRoot, 'codex-subscription', 'codex-home'), linkedRoot))
      .rejects.toThrow(/symbolic-link|directory/u)
    await expect(lstat(join(target, 'codex-subscription'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a terminal CODEX_HOME symlink without changing its target permissions', async () => {
    const base = await fixture()
    const root = join(base, 'root')
    const target = join(base, 'outside-target')
    await mkdir(join(root, 'codex-subscription'), { recursive: true })
    await mkdir(target)
    await writeFile(join(target, 'sentinel'), 'leave unchanged')
    const originalMode = (await stat(target)).mode & 0o777
    await symlink(target, join(root, 'codex-subscription', 'codex-home'), 'dir')

    await expect(secureCodexHome(join(root, 'codex-subscription', 'codex-home'), root))
      .rejects.toThrow(/symbolic-link|directory/u)
    expect((await stat(target)).mode & 0o777).toBe(originalMode)
    await expect(readFile(join(target, 'sentinel'), 'utf8')).resolves.toBe('leave unchanged')
  })

  it.each(['parent', 'Official profile'])('rejects a child symlink to a synthetic %s path before creating children', async (name) => {
    const base = await fixture()
    const root = join(base, 'root')
    const target = join(base, name)
    await mkdir(root)
    await mkdir(target)
    await symlink(target, join(root, 'codex-subscription'), 'dir')

    await expect(secureCodexHome(join(root, 'codex-subscription', 'codex-home'), root))
      .rejects.toThrow(/symbolic-link|directory/u)
    await expect(lstat(join(target, 'codex-home'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects outside-root and near-prefix paths lexically before creating either target', async () => {
    const base = await fixture()
    const root = join(base, 'root')
    const outside = join(base, 'root-near-prefix', 'codex-home')
    await mkdir(root)
    await expect(secureCodexHome(join(base, 'outside', 'codex-home'), root)).rejects.toThrow(/inside/u)
    await expect(secureCodexHome(outside, root)).rejects.toThrow(/inside/u)
    await expect(lstat(join(base, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(base, 'root-near-prefix'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-directory component before changing its sibling or starting a server', async () => {
    const base = await fixture()
    const root = join(base, 'root')
    await mkdir(root)
    await writeFile(join(root, 'codex-subscription'), 'not a directory')
    const home = join(root, 'codex-subscription', 'codex-home')
    await expect(secureCodexHome(home, root)).rejects.toThrow()
    await expect(readFile(join(root, 'codex-subscription'), 'utf8')).resolves.toBe('not a directory')
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('recognizes only the macOS /tmp to /private/tmp system alias', async () => {
    if (process.platform !== 'darwin') return
    const base = await realpath(await mkdtemp('/private/tmp/dsh-codex-home-alias-'))
    roots.push(base)
    const root = join(base, 'trusted')
    const home = join(root, 'codex-subscription', 'codex-home')
    await mkdir(root)
    const aliasRoot = join('/tmp', relative('/private/tmp', root))
    const aliasHome = join(aliasRoot, 'codex-subscription', 'codex-home')

    await secureCodexHome(aliasHome, root)
    await expect(verifyCodexHome(home, aliasRoot)).resolves.toBe(home)
  })
})
