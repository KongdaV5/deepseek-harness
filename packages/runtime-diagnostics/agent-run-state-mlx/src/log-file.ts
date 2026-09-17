/** Append-only line follower for an external MLX log file. */

import { watchFile, unwatchFile } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

type Warn = (error: unknown) => void

/** Read appended complete UTF-8 lines without replaying records that predate startup. */
export class MlxLogFileFollower {
  private offset = 0
  private partial = ''
  private decoder = new StringDecoder('utf8')
  private tail: Promise<void> = Promise.resolve()
  private started = false
  private stopped = false

  constructor(
    private readonly path: string,
    private readonly pollIntervalMs: number,
    private readonly onLine: (line: string) => void,
    private readonly warn: Warn,
  ) {}

  /** Start at the file's current end; a missing file starts at byte zero when it appears. */
  async start(): Promise<void> {
    if (this.started) throw new Error('MLX log follower is already started')
    this.started = true
    try {
      this.offset = (await stat(this.path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    watchFile(this.path, { persistent: false, interval: this.pollIntervalMs }, this.onChanged)
  }

  /** Read appended records immediately; tests and diagnostic callers need not wait for the poll timer. */
  async poll(): Promise<void> {
    this.enqueue()
    await this.tail
  }

  /** Stop notifications and await the last queued read. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    unwatchFile(this.path, this.onChanged)
    await this.tail
  }

  private readonly onChanged = (): void => { this.enqueue() }

  private enqueue(): void {
    if (this.stopped) return
    this.tail = this.tail.then(() => this.readAppended()).catch((error: unknown) => { this.warn(error) })
  }

  private reset(): void {
    this.offset = 0
    this.partial = ''
    this.decoder = new StringDecoder('utf8')
  }

  private async readAppended(): Promise<void> {
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch (error) {
      /* v8 ignore next -- a non-ENOENT stat fault after a successful start needs a permission/kernel failure racing a watched path. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.reset()
      return
    }
    if (size < this.offset) this.reset()
    if (size === this.offset) return

    const file = await open(this.path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - this.offset))
      while (this.offset < size) {
        const length = Math.min(buffer.length, size - this.offset)
        const { bytesRead } = await file.read(buffer, 0, length, this.offset)
        /* v8 ignore next -- zero bytes requires truncation racing the interval between successful stat and the positional read. */
        if (bytesRead === 0) return
        this.offset += bytesRead
        this.consume(this.decoder.write(buffer.subarray(0, bytesRead)))
      }
    } finally {
      await file.close()
    }
  }

  private consume(text: string): void {
    const records = `${this.partial}${text}`.split(/\r?\n/u)
    this.partial = records.pop() as string
    for (const line of records) this.onLine(line)
  }
}
