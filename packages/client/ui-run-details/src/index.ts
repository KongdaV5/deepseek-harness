/**
 * Host face of the browser-only plugin.
 *
 * The desktop composition loader applies both package faces. The actual
 * diagnostics UI is declared by `dsh.client`; keeping this host face a no-op
 * makes that split explicit without registering a second transport or any
 * host-side policy.
 */
export function apply(): void {}
