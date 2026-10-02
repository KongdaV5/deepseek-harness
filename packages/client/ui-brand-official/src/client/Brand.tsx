import { BrandWordmark, DshMascotMark } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the animated assistant mark with the presentation requested by its
 * host surface.
 * @param props - Host-supplied mark presentation.
 * @returns The animated DS Harness mascot.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <DshMascotMark size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export function OfficialBrandName() {
  return <BrandWordmark includeMark={false} />
}
