/** Copy owned by the optional Computer Use client contribution. */
export const en = {
  title: 'Computer Use', localOnly: 'Foreground Local sessions only. Codex and scheduled tasks cannot use the desktop.',
  'status.computerUse': 'Computer Use', 'status.lease': 'Lease', 'status.globalStop': 'Global Stop',
  permissions: 'Permissions', check: 'Check permissions', request: 'Request permissions',
  stop: 'Global Stop', resume: 'Resume after stop', inUse: 'Desktop in use', idle: 'Desktop idle',
  takeover: 'For passwords, verification codes, payments or sensitive actions, take over manually. Stop cannot undo physical actions.',
  poison: 'An action may still have happened. Do not replay it. Restart the Host and driver, then observe the desktop before continuing.',
  'driver-unavailable': 'Driver unavailable', ready: 'Driver ready', 'not-requested': 'Not checked',
  granted: 'Granted', denied: 'Denied', 'needs-restart': 'Restart required', loading: 'Reading Host status…',
  failed: 'Host unavailable. Desktop status could not be verified.', accessibility: 'Accessibility', recording: 'Screen Recording',
  running: 'Not engaged', stopping: 'Stopping and draining', stopped: 'Engaged', active: 'In use', draining: 'Draining', poisoned: 'Blocked: unknown outcome', released: 'Idle',
} as const
/** Typed dictionary keys. */
export type CopyKey = keyof typeof en
/** Chinese counterpart for the same controls and safety facts. */
export const zh: Record<CopyKey, string> = {
  title: '电脑操作', localOnly: '仅支持前台 Local 会话。Codex 和自动任务不能操作桌面。',
  'status.computerUse': '电脑操作', 'status.lease': '租约', 'status.globalStop': '全局停止',
  permissions: '权限', check: '检查权限', request: '请求权限', stop: '全局停止', resume: '停止后恢复',
  inUse: '桌面正在使用', idle: '桌面空闲', takeover: '密码、验证码、付款及敏感操作请手动接管。停止不能撤销已经发生的操作。',
  poison: '动作可能已经发生，请勿重放。重启 Host 和驱动后，先重新观察桌面再继续。',
  'driver-unavailable': '驱动不可用', ready: '驱动就绪', 'not-requested': '尚未检查', granted: '已授权', denied: '未授权',
  'needs-restart': '需要重启', loading: '正在读取 Host 状态…', failed: 'Host 不可用，无法确认桌面状态。',
  accessibility: '辅助功能', recording: '屏幕录制', running: '未触发', stopping: '正在停止并等待操作结束', stopped: '已触发',
  active: '正在使用', draining: '正在等待操作结束', poisoned: '已阻止：操作结果未知', released: '空闲',
}
