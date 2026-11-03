---
kind: upgrade-guide
description: "Custom settings and Session identity conversion on the RC.2 foundation."
---

# Custom settings and Session V4

English | [中文](guide.zh.md)

## Change

Custom uses official plugin Config and profile patches. Legacy SettingsScope consumers are removed. Native Custom Session events use plugin-qualified identities and V4 event references; the old identities remain only in the incoming V3 conversion.

## Migration

1. Use an isolated migration candidate with the desktop-custom profile. The bootstrap translates known legacy sections, retains the settings archive and records an import digest before the Loader mounts Settings. Preserve the archive for unknown sections and interruption recovery.
2. Open copied Session fixtures through the official immutable generation migration. Retain every committed V3 generation beside its validated V4 successor. Do not run this M1 mechanism on live user data.
3. Verify the focused fixtures and consult the [migration ledger](../../../custom-foundation.md). Unresolved Codex states require reconciliation; migration never authorizes dispatch or changes authentication lifecycle. Runtime and Desktop integration remain M2 work.
