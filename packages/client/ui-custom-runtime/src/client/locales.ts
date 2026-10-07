/** Custom runtime control copy owned by this surface. */
export const en = { title: 'Custom runtimes', local: 'Local models', localRuntime: 'Local runtime', profiles: 'Installed model profiles', addModel: 'Add local model', addingModel: 'Adding model…', modelAdded: 'Model added. Use Start to load it.', addModelHint: 'Register an installed GGUF text model or a Qwen Image 2.1 MFlux model directory. The model stays on this Mac.', profileId: 'Profile ID', invalidProfileId: 'Use 1–64 lowercase letters, numbers, underscores, or hyphens.', duplicateProfileId: 'This profile ID is already in use.', modelName: 'Model name', invalidModelName: 'Enter a name up to 120 characters.', modelPath: 'GGUF file or MFlux model directory', invalidModelPath: 'Enter an absolute local path, starting with /.', modality: 'Model type', endpoint: 'Endpoint', codex: 'Codex subscription', unknown: 'Unknown', checking: 'Checking status', start: 'Start', stop: 'Stop', runtime: 'Runtime', reconnect: 'Reconnect', connect: 'Sign in', cancelLogin: 'Cancel sign-in', disconnect: 'Sign out', refresh: 'Refresh status',
  auto: 'Automatic', system: 'System', bundled: 'Bundled', stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', runtimeError: 'Error', error: 'Unavailable', connected: 'Connected', 'not-connected': 'Not connected', 'reauth-required': 'Sign-in required',
  localHint: 'Choose the exact installed model to serve. A stopped or unavailable model never falls back to a cloud service.', codexHint: 'Uses the official Codex App Server with an independent subscription home. Changing the runtime preserves account and thread ownership.',
  disabled: 'Disabled in this profile', unavailable: 'Unavailable', available: 'Available', usage: 'Usage', unavailableUsage: 'Usage information unavailable', source: 'Source',
  ready: 'Ready', initializing: 'Initializing', crashed: 'Crashed', 'signing-in': 'Signing in', modelsAvailable: 'Available models',
  'auth-check': 'Checking connection', 'catalog-loading': 'Loading models',
  primaryUsage: 'Primary window', secondaryUsage: 'Secondary window', minutes: 'min', resets: 'Resets',
  current: 'Current profile', restart: 'Restart', text: 'Text', image: 'Image',
}
/** Locale key vocabulary for Custom runtime controls. */
export type CopyKey = keyof typeof en
/** Simplified Chinese control copy with the same key domain. */
export const zh: Record<CopyKey, string> = { title: 'Custom 运行时', local: '本地模型', localRuntime: '本地运行时', profiles: '已安装的模型配置', addModel: '添加本地模型', addingModel: '正在添加模型…', modelAdded: '模型已添加。点击“启动”即可加载。', addModelHint: '登记已安装的 GGUF 文本模型，或 Qwen Image 2.1 的 MFlux 模型目录。模型文件仍保存在这台 Mac 上。', profileId: '配置 ID', invalidProfileId: '使用 1–64 位小写字母、数字、下划线或连字符。', duplicateProfileId: '该配置 ID 已被使用。', modelName: '模型名称', invalidModelName: '请输入不超过 120 个字符的名称。', modelPath: 'GGUF 文件或 MFlux 模型目录', invalidModelPath: '请输入以 / 开头的本地绝对路径。', modality: '模型类型', endpoint: '服务地址', codex: 'Codex 订阅', unknown: '未知', checking: '正在检查状态', start: '启动', stop: '停止', runtime: '运行时', reconnect: '重新连接', connect: '登录', cancelLogin: '取消登录', disconnect: '退出登录', refresh: '刷新状态',
  auto: '自动', system: '系统', bundled: '内置', stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', runtimeError: '错误', error: '不可用', connected: '已连接', 'not-connected': '未连接', 'reauth-required': '需要重新登录',
  localHint: '选择要运行的确切本地模型。模型停止或不可用时，不会自动回退到云端。', codexHint: '使用官方 Codex App Server 和独立订阅目录。更换运行时保留账户与线程归属。',
  disabled: '当前 profile 已禁用', unavailable: '不可用', available: '可用', usage: '用量', unavailableUsage: '暂时无法获取用量信息', source: '来源',
  ready: '就绪', initializing: '初始化中', crashed: '已崩溃', 'signing-in': '正在登录', modelsAvailable: '可用模型数量',
  'auth-check': '正在检查连接', 'catalog-loading': '正在加载模型',
  primaryUsage: '短周期用量', secondaryUsage: '长周期用量', minutes: '分钟', resets: '重置时间',
  current: '当前 profile', restart: '重启', text: '文本', image: '图像',
}
