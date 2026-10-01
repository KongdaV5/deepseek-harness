/**
 * Host-side control for the user's existing local-model LaunchAgent. The
 * controller delegates to the already-installed manager CLI and never builds
 * a model command line itself.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/local-model-runtime
 */

import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  LocalModelProfileId, LocalModelRuntimeProfile, LocalModelRuntimeSnapshot,
} from './local-runtime-types.ts'

const execFile = promisify(execFileCallback)
const SERVICE_LABEL = 'com.kongda.local-mlx'
const PORT = 8080
const ENDPOINT = `http://127.0.0.1:${String(PORT)}/v1`
const MANAGEABLE_PROFILES = new Set<LocalModelProfileId>(['huihui', 'img21', '38'])
const PROFILE_IDS: readonly LocalModelProfileId[] = ['huihui', 'img21', '38']

/** Values replaceable by deterministic Host tests. */
export interface LocalModelRuntimeDriver {
  profiles(): Promise<RuntimeProfile[]>
  dispose?(): Promise<void>
  probe(): Promise<LocalModelRuntimeProbe>
  run(command: 'runtime-start' | 'stop', profile?: LocalModelProfileId): Promise<void>
  waitFor(predicate: (probe: LocalModelRuntimeProbe) => boolean, timeoutMs: number): Promise<LocalModelRuntimeProbe>
}

/** Facts from one fresh probe; the model-serving endpoint is always loopback. */
export interface LocalModelRuntimeProbe {
  readonly available: boolean
  readonly unavailableReason?: string
  readonly managed: boolean
  readonly launchState?: 'running' | 'waiting' | 'other'
  readonly listening: boolean
  readonly modelIds: readonly string[]
}

/** Host-only data used to match a local server's exact model identifier. */
export interface RuntimeProfile extends LocalModelRuntimeProfile {
  readonly modelId: string
}

/** Runtime controls are opt-in and enabled by the DS Harness Custom bundle. */
export interface LocalModelRuntimeConfig {
  readonly enabled: () => boolean
  readonly endpoint: string
  /** Canonical intent owner invoked only after exact serving health is proven. */
  readonly onSelected?: (profile: LocalModelProfileId) => Promise<void>
}

/** Host facts not needed by the browser-facing profile. */
interface SystemDriverOptions {
  readonly inventory: () => readonly { id: string; name: string; modality: 'text' | 'image'; modelId: string }[]
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  readonly execute?: (file: string, args: readonly string[], timeoutMs: number) => Promise<string>
  readonly pathExists?: (path: string, directory?: boolean) => Promise<boolean>
  readonly fetchModels?: () => Promise<readonly string[]>
  readonly portOpen?: () => Promise<boolean>
  readonly pause?: (milliseconds: number) => Promise<void>
}

/**
 * One controller and its one-child operation queue. Start/restart always wait
 * for the known LaunchAgent and port to be down before selecting another
 * profile; an unmanaged listener is never stopped.
 */
export class LocalModelRuntimeController extends TypertRemoteService {

  private operation: { readonly state: 'starting' | 'stopping'; readonly profile: LocalModelProfileId | null } | undefined
  private lastError: string | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly driver: LocalModelRuntimeDriver

  /**
   * @param ctx - Host context carrying the typed Remote registry.
   * @param config - whether this deployment exposes local-runtime actions.
   * @param driver - production manager integration, replaceable by tests.
   */
  constructor(
    ctx: Context,
    private readonly config: LocalModelRuntimeConfig,
    driver?: LocalModelRuntimeDriver,
  ) {
    super(ctx, 'localModelRuntimeController', { namespace: 'localModels' })
    if (driver === undefined) throw new Error('Local runtime requires an explicit driver owner')
    this.driver = driver
    ctx.effect(() => async () => {
      this.disposed = true
      await this.driver.dispose?.()
      await this.queue.catch(() => {})
    }, 'local-runtime: drain operations and dispose owned child')
  }

  /**
   * Return a fresh LaunchAgent and health observation; no in-memory green cache is trusted.
   * @returns the current manager, endpoint, and installed-profile state.
   * @throws RemoteError when the local profile inventory or Host probe fails unexpectedly.
   */
  @Remote
  async status(): Promise<LocalModelRuntimeSnapshot> {
    if (!this.config.enabled()) return { ...disabledSnapshot(), endpoint: this.config.endpoint }
    const [profiles, probe] = await Promise.all([this.driver.profiles(), this.driver.probe()])
    const current = this.project(profiles, probe)
    if (current.state === 'running') this.lastError = undefined
    return {
      ...current,
      ...(this.lastError !== undefined && current.state === 'stopped' ? { state: 'error' as const } : {}),
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
      ...(this.operation === undefined ? {} : {
        state: this.operation.state,
        profile: this.operation.profile,
      }),
    }
  }

  /**
   * Start one allowlisted local profile after releasing the shared port.
   * @param profile - local-model manager profile to activate.
   * @returns the profile state after its loopback health check succeeds.
   * @throws RemoteError when disabled, unavailable, unsafe, or not healthy after start.
   */
  @Remote
  start(profile: LocalModelProfileId): Promise<LocalModelRuntimeSnapshot> {
    return this.exclusive(() => this.startLocked(profile))
  }

  /**
   * Stop only the verified manager LaunchAgent, and confirm port release.
   * @returns the stopped state after the manager and shared port are confirmed down.
   * @throws RemoteError when the manager is unavailable, ownership is ambiguous, or shutdown fails.
   */
  @Remote
  stop(): Promise<LocalModelRuntimeSnapshot> {
    return this.exclusive(() => this.stopLocked())
  }

  /**
   * Stop, verify release, then start the requested profile in the same queue.
   * @param profile - local-model manager profile to activate after shutdown.
   * @returns the profile state after its loopback health check succeeds.
   * @throws RemoteError when shutdown cannot be verified or the new profile is not healthy.
   */
  @Remote
  restart(profile: LocalModelProfileId): Promise<LocalModelRuntimeSnapshot> {
    return this.exclusive(async () => {
      await this.stopLocked()
      return this.startLocked(profile)
    })
  }

  private async startLocked(profile: LocalModelProfileId): Promise<LocalModelRuntimeSnapshot> {
    this.requireEnabled()
    if (!PROFILE_IDS.includes(profile) || !MANAGEABLE_PROFILES.has(profile)) {
      throw new RemoteError(
        'gateway/bad-request',
        'Unknown local model profile.',
        {},
      )
    }

    const profiles = await this.driver.profiles()
    const target = profiles.find(candidate => candidate.id === profile)
    if (target === undefined || !target.available) {
      throw new RemoteError('gateway/internal',
        target?.unavailableReason ?? `Local model profile "${profile}" is not installed.`, { profile })
    }

    let probe = await this.driver.probe()
    this.assertManagerAvailable(probe)
    if (probe.listening && !probe.managed) {
      throw new RemoteError('gateway/internal',
        'The configured Local endpoint is occupied by a service outside the local-model manager; it was left untouched.', {})
    }
    const serving = this.servedProfile(probe.modelIds, profiles)
    if (probe.managed && probe.listening && serving === profile) {
      await this.config.onSelected?.(profile)
      return this.project(profiles, probe)
    }
    if (probe.listening && serving === undefined) {
      throw new RemoteError('gateway/internal',
        'The managed service on the configured endpoint is serving an unrecognized model; it was left untouched.', {})
    }

    if (probe.managed) {
      this.operation = { state: 'stopping', profile: serving ?? null }
      await this.driver.run('stop')
      probe = await this.driver.waitFor(candidate => !candidate.managed && !candidate.listening, 180_000)
      if (probe.managed || probe.listening) {
        throw new RemoteError('gateway/internal', 'The previous model service did not release its LaunchAgent and port.', {})
      }
    }

    // Check again immediately before loading the next profile: another local
    // process may have claimed 8080 while the prior manager was unloading.
    probe = await this.driver.probe()
    if (probe.listening || probe.managed) {
      throw new RemoteError('gateway/internal',
        'The local-model service did not reach a fully stopped state; no new profile was started.', {})
    }

    this.operation = { state: 'starting', profile }
    await this.driver.run('runtime-start', profile)
    probe = await this.driver.waitFor(
      candidate => candidate.managed && candidate.listening && this.servedProfile(candidate.modelIds, profiles) === profile,
      profile === 'img21' ? 900_000 : 210_000,
    )
    if (!probe.managed || !probe.listening || this.servedProfile(probe.modelIds, profiles) !== profile) {
      throw new RemoteError('gateway/internal', `The ${target.name} server did not pass its local health check.`, { profile })
    }
    this.lastError = undefined
    await this.config.onSelected?.(profile)
    return this.project(profiles, probe)
  }

  private async stopLocked(): Promise<LocalModelRuntimeSnapshot> {
    this.requireEnabled()
    const profiles = await this.driver.profiles()
    let probe = await this.driver.probe()
    this.assertManagerAvailable(probe)
    if (probe.listening && !probe.managed) {
      throw new RemoteError('gateway/internal',
        'The configured Local endpoint is occupied by a service outside the local-model manager; it was left untouched.', {})
    }
    if (probe.managed) {
      this.operation = { state: 'stopping', profile: this.servedProfile(probe.modelIds, profiles) ?? null }
      await this.driver.run('stop')
      probe = await this.driver.waitFor(candidate => !candidate.managed && !candidate.listening, 180_000)
    }
    if (probe.managed || probe.listening) {
      throw new RemoteError('gateway/internal', 'The local-model service did not confirm shutdown and port release.', {})
    }
    this.lastError = undefined
    return this.project(profiles, probe)
  }

  private project(profiles: RuntimeProfile[], probe: LocalModelRuntimeProbe): LocalModelRuntimeSnapshot {
    const publicProfiles = profiles.map(({ modelId: _modelId, ...profile }) => profile)
    if (!probe.available) {
      return {
        enabled: true, available: false, state: 'error', canStop: false, profile: null, endpoint: this.config.endpoint,
        profiles: publicProfiles, error: probe.unavailableReason ?? 'The local model manager is unavailable.',
      }
    }
    if (!probe.managed && probe.listening) {
      return {
        enabled: true, available: true, state: 'error', canStop: false, profile: null, endpoint: this.config.endpoint,
        profiles: publicProfiles, error: 'The configured Local endpoint is occupied by a service outside the local-model manager.',
      }
    }
    const profile = this.servedProfile(probe.modelIds, profiles)
    if (probe.managed && probe.listening && profile !== undefined) {
      return { enabled: true, available: true, state: 'running', canStop: probe.managed, profile,
        endpoint: this.config.endpoint, profiles: publicProfiles }
    }
    if (probe.managed && !probe.listening && probe.launchState === 'running') {
      if (this.operation?.state === 'starting') {
        return { enabled: true, available: true, state: 'starting', canStop: probe.managed, profile: null,
          endpoint: this.config.endpoint, profiles: publicProfiles }
      }
    }
    if (probe.managed || (probe.listening && profile === undefined)) {
      return {
        enabled: true, available: true, state: 'error', canStop: probe.managed, profile: null, endpoint: this.config.endpoint,
        profiles: publicProfiles,
        error: 'The managed model service is not healthy or its served model is not recognized.',
      }
    }
    return { enabled: true, available: true, state: 'stopped', canStop: false, profile: null, endpoint: this.config.endpoint,
      profiles: publicProfiles }
  }

  private servedProfile(ids: readonly string[], profiles: readonly RuntimeProfile[]): LocalModelProfileId | undefined {
    return profiles.find(profile => ids.includes(profile.modelId))?.id
  }

  private assertManagerAvailable(probe: LocalModelRuntimeProbe): void {
    if (!probe.available) {
      throw new RemoteError('gateway/internal', probe.unavailableReason ?? 'The local model manager is unavailable.', {})
    }
  }

  private requireEnabled(): void {
    if (this.disposed) throw new Error('Local runtime has been disposed')
    if (!this.config.enabled()) {
      throw new RemoteError('gateway/internal', 'Local model controls are not enabled in this deployment.', {})
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      try { return await action() }
      catch (error: unknown) { this.lastError = errorMessage(error); throw error }
      finally { this.operation = undefined; this.ctx.emit('llm/adapters-updated') }
    }
    const pending = this.queue.then(execute, execute)
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Remote namespace for the existing local-model service. */
    localModelRuntimeController: LocalModelRuntimeController
  }
}

/** Production integration with the existing user's signed-off local manager. */
export class SystemLocalModelRuntimeDriver implements LocalModelRuntimeDriver {
  private readonly lifetime = new AbortController()
  private readonly home: string
  private readonly platform: NodeJS.Platform
  private readonly uid: number
  private readonly execute: NonNullable<SystemDriverOptions['execute']>
  private readonly pathExists: NonNullable<SystemDriverOptions['pathExists']>
  private readonly fetchModels: NonNullable<SystemDriverOptions['fetchModels']>
  private readonly portOpen: NonNullable<SystemDriverOptions['portOpen']>
  private readonly pause: NonNullable<SystemDriverOptions['pause']>

  constructor(private readonly options: SystemDriverOptions) {
    this.home = options.home ?? homedir()
    this.platform = options.platform ?? process.platform
    this.uid = options.uid ?? process.getuid?.() ?? 0
    this.execute = options.execute ?? (async (file, args, timeoutMs) => {
      const { stdout, stderr } = await execFile(file, [...args], {
        timeout: timeoutMs,
        signal: this.lifetime.signal,
        maxBuffer: 1024 * 1024,
        env: scrubCredentials(process.env),
      })
      return `${stdout}\n${stderr}`
    })
    this.pathExists = options.pathExists ?? (async (path, directory = false) => {
      try {
        const info = await stat(path)
        return directory ? info.isDirectory() : info.isFile()
      } catch { return false }
    })
    this.fetchModels = options.fetchModels ?? fetchServedModels
    this.portOpen = options.portOpen ?? (() => isPortOpen(PORT))
    this.pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Abort the owned manager invocation; the external LaunchAgent retains serving ownership.
   * @returns Fulfillment after cancellation is requested; the controller joins the active operation.
   */
  dispose(): Promise<void> { this.lifetime.abort(); return Promise.resolve() }

  async profiles(): Promise<RuntimeProfile[]> {
    const inventory = this.options.inventory().filter(profile => PROFILE_IDS.includes(profile.id as LocalModelProfileId))
    return Promise.all(inventory.map(profile => ({ ...profile,
      id: profile.id as LocalModelProfileId, manageable: true })).map(async (profile) => {
      const image = profile.modality === 'image'
      const available = await this.pathExists(profile.modelId, image)
      return {
        ...profile,
        available: profile.manageable && available,
        ...(profile.manageable && !available ? { unavailableReason: 'Model files are not present at the registered local path.' } : {}),
      }
    }))
  }

  async probe(): Promise<LocalModelRuntimeProbe> {
    if (this.platform !== 'darwin') {
      return { available: false, unavailableReason: 'The installed local-model manager is supported only on macOS.',
        managed: false, listening: false, modelIds: [] }
    }
    const manager = join(this.home, '.local', 'bin', 'local-model')
    const plist = join(this.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    try {
      await access(manager, constants.X_OK)
      if (!await this.pathExists(manager) || !await this.pathExists(plist)) throw new Error('local-model manager or LaunchAgent plist is missing')
      const plistJson = await this.execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], 3000)
      const parsed = JSON.parse(plistJson) as {
        Label?: unknown
        ProgramArguments?: unknown
        RunAtLoad?: unknown
        WorkingDirectory?: unknown
      }
      if (parsed.Label !== SERVICE_LABEL
        || !Array.isArray(parsed.ProgramArguments)
        || parsed.ProgramArguments[0] !== manager
        || parsed.ProgramArguments[1] !== 'serve'
        || parsed.RunAtLoad !== false
        || parsed.WorkingDirectory !== join(this.home, '.config', 'local-model')) {
        throw new Error('local-model LaunchAgent identity does not match the manager contract')
      }
    } catch (error) {
      return {
        available: false, unavailableReason: errorMessage(error), managed: false, listening: false, modelIds: [],
      }
    }

    let launchOutput = ''
    let managed = false
    try {
      launchOutput = await this.execute('/bin/launchctl', ['print', `gui/${String(this.uid)}/${SERVICE_LABEL}`], 3000)
      managed = true
    } catch {
      // launchctl returns non-zero for an unloaded label; the independent port probe detects foreign listeners.
      managed = false
    }
    const launchState = /\bstate = running\b/u.test(launchOutput)
      ? 'running'
      : /\bstate = waiting\b/u.test(launchOutput) ? 'waiting' : managed ? 'other' : undefined
    const listening = await this.portOpen()
    const modelIds = listening ? await this.fetchModels().catch(() => []) : []
    return { available: true, managed, ...(launchState === undefined ? {} : { launchState }), listening, modelIds }
  }

  async run(command: 'runtime-start' | 'stop', profile?: LocalModelProfileId): Promise<void> {
    const args = command === 'runtime-start'
      ? ['runtime-start', this.assertManageable(profile)]
      : ['stop']
    await this.execute(join(this.home, '.local', 'bin', 'local-model'), args,
      command === 'runtime-start' && profile === 'img21' ? 960_000 : 240_000)
  }

  async waitFor(predicate: (probe: LocalModelRuntimeProbe) => boolean, timeoutMs: number): Promise<LocalModelRuntimeProbe> {
    const deadline = Date.now() + timeoutMs
    let latest = await this.probe()
    while (!predicate(latest) && Date.now() < deadline) {
      this.lifetime.signal.throwIfAborted()
      await this.pause(1000)
      latest = await this.probe()
    }
    return latest
  }

  private assertManageable(profile: LocalModelProfileId | undefined): LocalModelProfileId {
    if (profile === undefined || !MANAGEABLE_PROFILES.has(profile)) throw new TypeError(`unsupported local model profile: ${String(profile)}`)
    return profile
  }
}

async function fetchServedModels(): Promise<readonly string[]> {
  const response = await fetch(`${ENDPOINT}/models`, { signal: AbortSignal.timeout(2000) })
  if (!response.ok) return []
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) return []
  const data: unknown = Reflect.get(body, 'data')
  if (!Array.isArray(data)) return []
  const entries: readonly unknown[] = data
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const id: unknown = Reflect.get(entry, 'id')
    return typeof id === 'string' ? [id] : []
  })
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
    socket.setTimeout(750, () => { finish(false) })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Prevent inherited provider credentials from reaching the local manager. */
function scrubCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key),
  ))
}

function disabledSnapshot(): LocalModelRuntimeSnapshot {
  return {
    enabled: false,
    available: false,
    state: 'stopped',
    canStop: false,
    profile: null,
    endpoint: ENDPOINT,
    profiles: [],
  }
}

/** One process-control composition, with inventory and intent read from canonical Custom Config. */
export default class LocalRuntimePlugin extends LocalModelRuntimeController {
  static inject = ['customFoundation']
  static Config = z.object({
    endpoint: z.string().default('http://127.0.0.1:8080/v1'),
    driver: z.union(['launch-agent', 'owned-process']).default('launch-agent'),
    binary: z.string(),
    cwd: z.string(),
    args: z.array(z.string()).default([]),
  })
  /** Mount the sole Local controller and turn-admission observer.
   * @param ctx Plugin lifecycle and canonical inventory reader.
   * @param config Process deployment; alternate serving resources require matching provider configuration.
   */
  constructor(ctx: Context,
    config: { endpoint: string; driver: 'launch-agent' | 'owned-process'; binary?: string; cwd?: string; args: string[] }) {
    const endpoint = new URL(config.endpoint)
    if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || endpoint.pathname !== '/v1' || !endpoint.port || endpoint.search !== '' || endpoint.hash !== '' || endpoint.username !== '' || endpoint.password !== '') {
      throw new Error('Local runtime endpoint must be an explicit loopback /v1 resource')
    }
    const inventory = () => ctx.customFoundation.snapshot().profiles
    if (config.driver === 'launch-agent' && config.endpoint !== ENDPOINT) throw new Error('LaunchAgent owns only its qualified serving resource')
    if (config.driver === 'owned-process' && (config.binary === undefined || config.cwd === undefined)) {
      throw new Error('Owned Local process requires an explicit binary and working directory')
    }
    const binary = config.binary ?? ''
    const cwd = config.cwd ?? ''
    const driver = config.driver === 'launch-agent'
      ? new SystemLocalModelRuntimeDriver({ inventory })
      : new OwnedLocalProcessDriver(ctx, {
        endpoint: config.endpoint, binary, cwd, args: config.args,
      }, inventory)
    super(ctx, { enabled: () => ctx.customFoundation.snapshot().localModelRuntime, endpoint: config.endpoint,
      onSelected: profile => ctx.customFoundation.saveSelectedProfile(profile) }, driver)
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const selected = agent.ctx.get('agentModelSelection')?.assembled ?? agent.options
      if (selected.provider !== 'dsh-local-huihui') return next()
      const state = await this.status()
      const served = inventory().find(p => p.id === state.profile)
      if (state.state !== 'running' || served?.modelId !== selected.model) {
        throw new Error('Selected Local model is unavailable; start that exact profile or explicitly select another model')
      }
      return next()
    })
  }
}

import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from './index.ts'
import { OwnedLocalProcessDriver } from './owned-local-driver.ts'
