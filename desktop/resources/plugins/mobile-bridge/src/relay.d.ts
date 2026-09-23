/** relay.js 是手写的 JS（没有对应 TS 源码），这里给它最小声明。 */
export function startRelayLink(options: {
  candidates: Array<{ url: string; label?: string; name?: string }>
  deviceKey: string
  secret: string
  localPort: number
  log?: (line: string) => void
}): {
  /** 停掉链路（插件卸载时调用）。 */
  stop: () => void
  /** 'online' | 'connecting' | 'offline' */
  status: () => string
  /** 当前正在用（或正在尝试）的线路。 */
  current: () => { url: string; label?: string; name?: string } | undefined
}
