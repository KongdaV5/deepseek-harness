/** Explicit environment selector for the DS Harness-only local macOS qualification mode. */
export const DESKTOP_LOCAL_MACOS_QUALIFICATION_ENV: 'DSH_DESKTOP_LOCAL_MACOS_QUALIFICATION'

/** Validate the staging-only macOS qualification mode. */
export function isDesktopLocalMacOSQualification(
  environment: NodeJS.ProcessEnv,
  target: { platform: 'darwin' | 'win32' },
  options?: { directory?: boolean },
): boolean

/** Ad-hoc-sign and strictly verify the isolated application emitted by electron-builder. */
export function qualifyLocalMacOSApplication(artifactsRoot: string, targetName: string, productName: string): string
