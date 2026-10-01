/** Narrow JSON-RPC client for the pinned, package-local official Codex App Server. */

import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

interface CodexPackageManifest {
  readonly version: string
}

interface CodexNativeTarget {
  readonly packageName: string
  readonly triple: string
}

const CODEX_NATIVE_TARGETS: Readonly<Record<string, CodexNativeTarget>> = {
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
}

const packageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as CodexPackageManifest
const codexTarget = CODEX_NATIVE_TARGETS[`${process.platform}-${process.arch}`]
if (codexTarget === undefined) throw new Error(`Codex App Server does not support ${process.platform}-${process.arch}`)
const packageRequire = createRequire(packageJsonPath)
const nativePackageJsonPath = packageRequire.resolve(`${codexTarget.packageName}/package.json`)
const nativeBinary = join(dirname(nativePackageJsonPath), 'vendor', codexTarget.triple, 'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex')
const asarPathMarker = '.asar/'
const archivePathIndex = nativeBinary.lastIndexOf(asarPathMarker)
const CODEX_BIN = resolve(archivePathIndex < 0 ? nativeBinary
  : `${nativeBinary.slice(0, archivePathIndex)}.asar.unpacked/${nativeBinary.slice(archivePathIndex + asarPathMarker.length)}`)

/** Safe App Server facts retained by the runtime; no protocol payload is logged. */
export interface CodexServerIdentity {
  readonly source: CodexRuntimeSource
  readonly packageVersion: string
  readonly capabilities: readonly string[]
}

/** One fixed executable choice for the lifetime of an App Server connection. */
export interface CodexRuntimeDescriptor {
  readonly source: CodexRuntimeSource
  readonly version: string
  readonly executablePath: string
  /** Verified local identity, retained in-process and never projected to the renderer. */
  readonly identity: string
}

/** Source of the fixed owned App Server executable. */
export type CodexRuntimeSource = 'system' | 'bundled'

/** Verified System discovery or a renderer-safe reason for absence. */
export interface SystemCodexRuntimeResolution {
  readonly runtime?: CodexRuntimeDescriptor
  /** Safe diagnostic without local paths. */
  readonly unavailableReason?: string
}

/** Protocol callbacks owned by the subscription runtime lifecycle. */
export interface CodexServerCallbacks {
  readonly onNotification: (method: string, params: JsonObject) => void
  readonly onRequest: (method: string, params: JsonObject) => Promise<unknown>
  readonly onExit: (error?: Error) => void
}

/** Protocol surface the runtime owns; injectable only to test lifecycle/recovery deterministically. */
export interface CodexAppServerConnection {
  initialize(): Promise<JsonObject>
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>
  dispose(): Promise<void>
}

/** Describe the package-local runtime without consulting PATH.
 * @returns the pinned Bundled executable descriptor.
 */
export function bundledCodexRuntime(): CodexRuntimeDescriptor {
  return {
    source: 'bundled',
    version: codexPackage.version,
    executablePath: CODEX_BIN,
    identity: `workspace-package:@openai/codex@${codexPackage.version}`,
  }
}

/** Discover only the signed Codex CLI embedded in the official ChatGPT app.
 * @returns verified System identity or a redacted availability diagnosis.
 */
export function resolveSystemCodexRuntime(): SystemCodexRuntimeResolution {
  if (process.platform !== 'darwin') return { unavailableReason: 'System Codex is available only in the macOS ChatGPT app.' }
  const appPath = '/Applications/ChatGPT.app'
  const cliBundle = join(appPath, 'Contents/Resources/codex-cli/CodexCLI.app')
  const executablePath = join(cliBundle, 'Contents/MacOS/codex')
  if (!existsSync(join(appPath, 'Contents/Info.plist')) || !existsSync(join(cliBundle, 'Contents/Info.plist'))
    || !existsSync(executablePath)) {
    return { unavailableReason: 'The official ChatGPT Codex runtime was not found in /Applications.' }
  }

  try {
    if (readBundleId(join(appPath, 'Contents/Info.plist')) !== 'com.openai.codex'
      || readBundleId(join(cliBundle, 'Contents/Info.plist')) !== 'com.openai.codex.cli') {
      throw new Error('unexpected application identity')
    }
    const app = verifySignedIdentity(appPath, 'com.openai.codex')
    // The nested CodexCLI Info.plist uses com.openai.codex.cli, while its
    // signed executable bundle identity is `codex`.
    const cli = verifySignedIdentity(cliBundle, 'codex')
    const binary = verifySignedIdentity(executablePath, 'codex')
    if (!runFixedTool('/usr/bin/lipo', ['-archs', executablePath]).trim().split(/\s+/u).includes(process.arch === 'x64' ? 'x86_64' : process.arch)) {
      throw new Error('unexpected executable architecture')
    }
    if (app.team !== '2DC432GLL2' || cli.team !== '2DC432GLL2' || binary.team !== '2DC432GLL2') {
      throw new Error('unexpected signing authority')
    }
    const versionOutput = runFixedTool(executablePath, ['--version'])
    const version = /^codex-cli\s+(\S+)\s*$/mu.exec(versionOutput)?.[1]
    if (version === undefined) throw new Error('Codex CLI did not report a version')
    return {
      runtime: {
        source: 'system',
        version,
        executablePath,
        identity: `${app.identifier}:${cli.identifier}:${binary.team}:${version}`,
      },
    }
  } catch {
    return { unavailableReason: 'The installed ChatGPT Codex runtime failed official identity verification.' }
  }
}

/** Reverify the fixed distribution and hash its actual native binary, never a PATH command.
 * @param runtime - the selected official or package-local descriptor.
 * @returns non-secret distribution, architecture, version and binary identity.
 */
export async function inspectCodexRuntime(runtime: CodexRuntimeDescriptor): Promise<{
  trustedLocationId: string
  signer: string
  architecture: string
  binaryFingerprint: string
}> {
  const expected = runtime.source === 'system' ? resolveSystemCodexRuntime().runtime : bundledCodexRuntime()
  if (expected === undefined || expected.executablePath !== runtime.executablePath || expected.identity !== runtime.identity
    || expected.version !== runtime.version) throw new Error('Codex executable identity changed or is not trusted.')
  const reported = /^codex-cli\s+(\S+)\s*$/mu.exec(runFixedTool(runtime.executablePath, ['--version']))?.[1]
  if (reported !== runtime.version) throw new Error('Codex binary version does not match the selected distribution.')
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(runtime.executablePath)) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Codex executable fingerprint received non-binary data.')
    hash.update(bytes)
  }
  return {
    trustedLocationId: runtime.source === 'system' ? 'official-chatgpt-macos' : `package:@openai/codex:${codexTarget?.packageName}`,
    signer: runtime.source === 'system' ? 'codex:2DC432GLL2' : `locked-package:@openai/codex@${codexPackage.version}`,
    architecture: `${process.platform}-${process.arch}`,
    binaryFingerprint: hash.digest('hex'),
  }
}

/** Resolve arguments for one already selected runtime descriptor.
 * @param runtime - the binary identity pinned to this App Server connection.
 * @returns the executable and stdio App Server arguments.
 */
export function codexServerArgv(runtime: CodexRuntimeDescriptor = bundledCodexRuntime()): readonly string[] {
  return [runtime.executablePath, 'app-server', '--stdio']
}

/** Package version included in diagnostics without reading any user auth/config.
 * @returns The installed official Codex package version.
 */
export function codexRuntimePackageVersion(): string {
  return codexPackage.version
}

/** One owned subprocess and its JSON-RPC connection. */
export class CodexAppServerClient implements CodexAppServerConnection {
  private readonly provenCapabilities = new Set<string>()

  /** Stable descriptor of the process owned by this client. */
  get identity(): CodexServerIdentity {
    return {
      source: this.runtime.source,
      packageVersion: this.runtime.version,
      capabilities: [...this.provenCapabilities].sort(),
    }
  }

  private readonly wire: JsonRpcLineTransport
  private closed = false

  private constructor(
    readonly child: SubprocessHandle,
    input: Readable,
    output: Writable,
    private readonly callbacks: CodexServerCallbacks,
    private readonly expectedHome: string,
    private readonly runtime: CodexRuntimeDescriptor,
  ) {
    this.wire = new JsonRpcLineTransport(input, output)
    this.wire.onNotification((method, params) => {
      try {
        this.callbacks.onNotification(method, params)
      } catch {
        this.callbacks.onExit(new Error('Codex App Server sent an invalid notification'))
      }
    })
    this.wire.onRequest((method, params) => this.callbacks.onRequest(method, params))
    this.wire.start()
    child.stderr?.on('data', () => {
      // Drain but never retain or log stderr: official runtime diagnostics may contain user paths or auth data.
    })
    child.stderr?.resume()
    void child.done.then(
      (outcome) => {
        if (this.closed) return
        const detail = outcome.exitCode === 0 ? 'exited' : 'exited unexpectedly'
        this.callbacks.onExit(new Error(`Codex App Server ${detail}`))
      },
      () => { if (!this.closed) this.callbacks.onExit(new Error('Codex App Server process failed')) },
    )
  }

  /** Spawn the official native runtime with only the dedicated DSH CODEX_HOME override. */
  /** Start one owned protocol child with an explicit subscription home.
   * @param spawn - official execution-world subprocess capability.
   * @param home - dedicated CODEX_HOME, never copied from another account.
   * @param cwd - explicit child working directory.
   * @param callbacks - runtime-owned notification, request and exit handlers.
   * @param runtime - fixed executable descriptor; defaults to the Bundled runtime.
   * @returns the sole client for this process lifetime.
   */
  static start(
    spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
    home: string,
    cwd: string,
    callbacks: CodexServerCallbacks,
    runtime: CodexRuntimeDescriptor = bundledCodexRuntime(),
  ): CodexAppServerClient {
    const child = spawn({
      argv: codexServerArgv(runtime),
      cwd,
      env: { CODEX_HOME: home },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2_000,
    })
    const input = child.stdout
    const output = child.stdin
    if (input === undefined || output === undefined) {
      child.terminate()
      throw new Error('Codex App Server did not provide its required stdio pipes')
    }
    return new CodexAppServerClient(child, input, output, callbacks, home, runtime)
  }

  /** Official initialize handshake. */
  async initialize(): Promise<JsonObject> {
    const result = jsonObject(await this.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.2.0-rc.2' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, 15_000), 'initialize response')
    const initializedHome = requiredString(result.codexHome, 'initialized CODEX_HOME')
    if (resolve(initializedHome) !== resolve(this.expectedHome)) {
      throw new Error('Codex App Server initialized with a different CODEX_HOME than the isolated DSH runtime home.')
    }
    requiredString(result.userAgent, 'Codex App Server identity')
    requiredString(result.platformFamily, 'Codex App Server platform family')
    requiredString(result.platformOs, 'Codex App Server platform')
    this.wire.notify('initialized')
    await this.wire.flush()
    this.provenCapabilities.add('initialize')
    return result
  }

  /** Make one named official App Server request under a bounded deadline. */
  async request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) throw new Error('Codex App Server is disconnected')
    const controller = new AbortController()
    const timer = setTimeout(() =>{  controller.abort(new Error(`Codex App Server ${method} timed out`)) }, timeoutMs)
    try {
      const result = await this.wire.request(method, params, controller.signal)
      this.provenCapabilities.add(method)
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  /** Close protocol state, terminate only this owned process range, and await quiescence. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.wire.close()
    try { this.child.stdin?.end() } catch { /* termination below remains authoritative */ }
    this.child.terminate()
    await this.child.waitForExit()
    await this.child.done.catch(() => {})
  }
}

function readBundleId(infoPlist: string): string {
  return runFixedTool('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist]).trim()
}

function verifySignedIdentity(path: string, identifier: string): { identifier: string; team: string } {
  runFixedTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
  const details = runFixedTool('/usr/bin/codesign', ['-dv', '--verbose=4', path])
  const actualIdentifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim()
  const team = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim()
  if (actualIdentifier !== identifier || team === undefined || team === 'not set') {
    throw new Error('signature identity mismatch')
  }
  return { identifier: actualIdentifier, team }
}

function runFixedTool(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.error !== undefined || result.status !== 0) throw new Error('verified runtime inspection failed')
  return `${result.stdout}${result.stderr}`
}

/** Validate a protocol value as a JSON object.
 * @param value - untrusted protocol value.
 * @param label - field used by the failure diagnosis.
 * @returns the validated object.
 */
export function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex App Server returned invalid ${label}`)
  }
  return value as JsonObject
}

/** Require non-empty protocol text.
 * @param value - untrusted field.
 * @param label - field used by the failure diagnosis.
 * @returns validated text.
 */
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Codex App Server returned invalid ${label}`)
  return value
}
