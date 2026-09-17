/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Directory replaced with the generated development project. */
  readonly projectDir: string
  /** Current workspace's `apps/cli` package directory. */
  readonly cliDir: string
  /** Current workspace's private Desktop Host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Release identity written into the disposable project metadata. */
  readonly release: DesktopRelease
  /** Explicit development-only bundle selected by the trusted launcher. */
  readonly composition?: DevelopmentComposition
}

/** Fixed capability bundles that an unpackaged Desktop may link from this checkout. */
export type DevelopmentComposition = 'phase2-6'

const DEVELOPMENT_COMPOSITIONS: Readonly<Record<DevelopmentComposition, {
  readonly packageName: string
  readonly packageDir: string
}>> = {
  'phase2-6': {
    packageName: '@deepseek-ai/dsh-desktop-dev-composition',
    packageDir: 'packages/bundle/desktop-dev-composition',
  },
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function removeOwnedPath(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (stat.isDirectory()) {
    rmSync(path, { recursive: true })
    return
  }
  unlinkSync(path)
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(realpathSync(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Link the direct loader entries declared by one development-only bundle.
 *
 * Cordis resolves a bundle patch's named loader entries from the active profile
 * project, not from the bundle's own package directory. The normal disposable
 * runtime mirror contains production's virtual-hoisted dependencies, while
 * checkout-only workspace packages live under this bundle's local
 * `node_modules`. Link only the declared direct dependencies so this remains a
 * narrowly scoped development-composition seam rather than an alternate
 * package installation mechanism.
 */
function linkCompositionDependencies(bundleDir: string, destinationModules: string, manifest: PackageManifest): void {
  for (const packageName of Object.keys(manifest.dependencies ?? {})) {
    const source = join(bundleDir, 'node_modules', ...packageName.split('/'))
    if (!existsSync(source)) {
      throw new Error(`desktop development: ${manifest.name ?? bundleDir} is missing linked dependency ${packageName}`)
    }
    const destination = join(destinationModules, ...packageName.split('/'))
    removeOwnedPath(destination)
    linkDirectory(source, destination)
  }
}

function mirrorDependencyLinks(sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      mkdirSync(join(destinationRoot, entry.name), { recursive: true })
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        linkDirectory(join(source, scoped.name), join(destinationRoot, entry.name, scoped.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) linkDirectory(source, join(destinationRoot, entry.name))
  }
}

/**
 * Replace one disposable project with links to the current built workspace.
 * @param options - Project destination, CLI package, and release identity.
 * @returns the absolute project directory supplied by the caller.
 */
export function prepareDevelopmentProject(options: DevelopmentProjectOptions): string {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/cli must be @deepseek-ai/dsh@${options.release.version}, found `
      + `${String(cliManifest.name)}@${String(cliManifest.version)}`,
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || hostManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host@${options.release.version}, found `
      + `${String(hostManifest.name)}@${String(hostManifest.version)}`,
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }

  removeOwnedPath(options.projectDir)
  createDevelopmentProjectMetadata(options.projectDir, options.release)
  const destinationModules = join(options.projectDir, 'node_modules')
  mkdirSync(destinationModules, { recursive: true })
  mirrorDependencyLinks(options.dependencyDir, destinationModules)
  const dshLink = join(destinationModules, '@deepseek-ai', 'dsh')
  removeOwnedPath(dshLink)
  linkDirectory(options.cliDir, dshLink)
  const hostLink = join(destinationModules, '@deepseek-ai', 'dsh-desktop-host')
  removeOwnedPath(hostLink)
  linkDirectory(options.hostDir, hostLink)
  if (options.composition !== undefined) {
    const composition = DEVELOPMENT_COMPOSITIONS[options.composition]
    const bundleDir = join(dirname(dirname(options.cliDir)), composition.packageDir)
    const manifest = readManifest(join(bundleDir, 'package.json'))
    if (manifest.name !== composition.packageName || manifest.version !== options.release.version) {
      throw new Error(`desktop development: ${composition.packageName} must match Desktop version ${options.release.version}`)
    }
    const bundleLink = join(destinationModules, ...composition.packageName.split('/'))
    removeOwnedPath(bundleLink)
    linkDirectory(bundleDir, bundleLink)
    linkCompositionDependencies(bundleDir, destinationModules, manifest)
    const projectManifest = readManifest(join(options.projectDir, 'package.json')) as PackageManifest & {
      dsh?: { profile?: { bundles?: string[] } }
      dependencies?: Record<string, string>
    }
    const bundles = projectManifest.dsh?.profile?.bundles
    if (bundles === undefined || projectManifest.dependencies === undefined) {
      throw new Error('desktop development: generated project metadata is invalid')
    }
    writeFileSync(join(options.projectDir, 'package.json'), `${JSON.stringify({
      ...projectManifest,
      dependencies: { ...projectManifest.dependencies, [composition.packageName]: options.release.version },
      dsh: { profile: { bundles: [...bundles, composition.packageName] } },
    }, undefined, 2)}\n`, { mode: 0o600 })
  }
  return options.projectDir
}
