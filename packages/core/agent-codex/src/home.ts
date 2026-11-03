/** Filesystem checks for the DSH-owned Codex App Server home. */

import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

/** Create the Codex home only below the independently selected DSH data root.
 * @param requestedHome - DSH-owned CODEX_HOME path.
 * @param trustedRoot - path supplied by the Desktop data-boundary resolver.
 * @returns Nothing; the verified directory receives owner-only permissions.
 * @throws when either path escapes the root or any path component is unsafe.
 */
export async function secureCodexHome(requestedHome: string, trustedRoot: string): Promise<void> {
  const { home, root } = await normalizePaths(requestedHome, trustedRoot)
  assertStrictlyWithin(root, home)

  await ensureDirectoryChain(root, true)
  await ensureDirectoryChain(home, true)
  await verifyCodexHome(home, root)
  await chmod(home, 0o700)
  await verifyCodexHome(home, root)
}

/** Recheck the DSH-owned CODEX_HOME immediately before launching App Server.
 * @param requestedHome - DSH-owned CODEX_HOME path.
 * @param trustedRoot - path supplied by the Desktop data-boundary resolver.
 * @returns Canonical CODEX_HOME path after component and containment checks.
 * @throws when a path component changed, is a symlink, or escaped the trusted root.
 */
export async function verifyCodexHome(requestedHome: string, trustedRoot: string): Promise<string> {
  const { home, root } = await normalizePaths(requestedHome, trustedRoot)
  assertStrictlyWithin(root, home)
  await ensureDirectoryChain(root, false)
  await ensureDirectoryChain(home, false)

  const canonicalRoot = await realpath(root)
  const canonicalHome = await realpath(home)
  if (canonicalRoot !== root || !isWithin(canonicalRoot, canonicalHome)) {
    throw new Error('Codex runtime home no longer resolves beneath the trusted DS Harness data root.')
  }
  return canonicalHome
}

async function normalizePaths(requestedHome: string, trustedRoot: string): Promise<{ home: string; root: string }> {
  if (!isAbsolute(requestedHome) || !isAbsolute(trustedRoot)) {
    throw new Error('Codex runtime home and trusted data root must be absolute paths.')
  }
  return {
    home: await normalizeKnownSystemAlias(requestedHome),
    root: await normalizeKnownSystemAlias(trustedRoot),
  }
}

async function normalizeKnownSystemAlias(path: string): Promise<string> {
  const absolute = resolve(path)
  const temporaryAlias = '/tmp'
  if (process.platform !== 'darwin'
    || (absolute !== temporaryAlias && !absolute.startsWith(`${temporaryAlias}/`))) return absolute
  try {
    if (await realpath(temporaryAlias) === '/private/tmp') {
      return join('/private/tmp', relative(temporaryAlias, absolute))
    }
  } catch {
    // The ordinary component checks below report a missing or invalid path.
  }
  return absolute
}

async function ensureDirectoryChain(path: string, createMissing: boolean): Promise<void> {
  const { root: filesystemRoot } = parse(path)
  let current = filesystemRoot
  await verifyDirectory(current)
  for (const segment of relative(filesystemRoot, path).split(sep).filter(Boolean)) {
    current = join(current, segment)
    let details
    try {
      details = await lstat(current)
    } catch (error: unknown) {
      if (!createMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (createError: unknown) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
      }
      details = await lstat(current)
    }
    await verifyDirectory(current, details)
  }
}

async function verifyDirectory(path: string, knownDetails?: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const details = knownDetails ?? await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error('Codex runtime home contains a non-directory or symbolic-link path component.')
  }
}

function assertStrictlyWithin(root: string, candidate: string): void {
  if (!isWithin(root, candidate) || root === candidate) {
    throw new Error('Codex runtime home must remain inside the trusted DS Harness data root.')
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
