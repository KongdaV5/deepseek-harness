/** Validate the assembled application, including native Office conversion outside ASAR. */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { resolveDesktopBuildProduct } from './desktop-release-environment.mjs'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, candidate: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
if (values.unsigned && !windows && !values.candidate) throw new Error('desktop smoke: unsigned artifacts require Windows')
if (values.candidate && (values.unsigned || windows || process.env.DSH_DESKTOP_CANDIDATE !== '1' || process.env.DSH_DESKTOP_PRODUCT_FLAVOR !== 'ds-harness')) throw new Error('desktop smoke: candidate artifacts require Custom macOS')
const artifacts = values.candidate ? join(paths.root, 'candidate-artifacts') : desktopArtifactOutput(paths, {
  unsigned: values.unsigned,
  skipNotarization: values['skip-notarization'],
}).directory
const product = resolveDesktopBuildProduct(process.env)
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', `${product.productName}.app`, 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const executable = windows ? join(application, `${product.productName}.exe`) : join(application, 'MacOS', product.productName)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
