/**
 * @deepseek-ai/dsh-desktop-custom — the DS Harness Desktop custom bundle. The
 * package's substance is `cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field and resolved by the profile composer through that field;
 * this module carries no runtime API.
 *
 * The layer is applied last, after `@deepseek-ai/dsh-base` and
 * `@deepseek-ai/dsh-web-app`, and holds no mutable state: every row it inserts
 * or restates is owned by the package that mounts it.
 *
 * @module @deepseek-ai/dsh-desktop-custom
 */

export {}
