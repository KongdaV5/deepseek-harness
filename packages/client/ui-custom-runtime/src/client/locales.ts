/** Custom runtime control copy owned by this surface. */
export const en = { title: 'Custom runtimes', local: 'Local models', codex: 'Codex subscription', unknown: 'Unknown', start: 'Start / switch to', stop: 'Stop', runtime: 'Runtime', reconnect: 'Reconnect', connect: 'Sign in', cancelLogin: 'Cancel sign-in', disconnect: 'Sign out', refresh: 'Refresh status',
  auto: 'Automatic', system: 'System', bundled: 'Bundled', stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', error: 'Unavailable', connected: 'Connected', 'not-connected': 'Not connected', 'reauth-required': 'Sign-in required',
  localHint: 'Choose the exact installed model to serve. A stopped or unavailable model never falls back to a cloud service.', codexHint: 'Uses the official Codex App Server with an independent subscription home. Changing the runtime preserves account and thread ownership.',
  disabled: 'Disabled in this profile', unavailable: 'Unavailable', available: 'Available', usage: 'Usage', unavailableUsage: 'Usage information unavailable', source: 'Source',
}
/** Locale key vocabulary for Custom runtime controls. */
export type CopyKey = keyof typeof en
/** Simplified Chinese control copy with the same key domain. */
export const zh: Record<CopyKey, string> = { title: 'Custom 运行时', local: '本地模型', codex: 'Codex 订阅', unknown: '未知', start: '启动 / 切换至', stop: '停止', runtime: '运行时', reconnect: '重新连接', connect: '登录', cancelLogin: '取消登录', disconnect: '退出登录', refresh: '刷新状态',
  auto: '自动', system: '系统', bundled: '内置', stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', error: '不可用', connected: '已连接', 'not-connected': '未连接', 'reauth-required': '需要重新登录',
  localHint: '选择要运行的确切本地模型。模型停止或不可用时，不会自动回退到云端。', codexHint: '使用官方 Codex App Server 和独立订阅目录。更换运行时保留账户与线程归属。',
  disabled: '当前 profile 已禁用', unavailable: '不可用', available: '可用', usage: '用量', unavailableUsage: '暂时无法获取用量信息', source: '来源',
}
