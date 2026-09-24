/**
 * 模型网络路由：每个 provider 可选「代理 / 直连」，未选择走默认（代理）。
 *
 * 引擎（dsh）的出站代理由 @deepseek-ai/dsh-http-proxy 在**进程启动**时从
 * HTTP(S)_PROXY / NO_PROXY 环境变量解析并安装——进程内没有第二个开关。
 * 因此这里的配置由桌面壳在拉起引擎时合成环境变量实现：
 *   - network.proxyUrl 非空 → HTTP(S)_PROXY = proxyUrl
 *   - network.routes 里标了 direct 的提供商 → 其主机加入 NO_PROXY（绕过代理）
 *   - noProxyHosts 是算好的结果（桥接负责维护，壳只读）
 * 改动需要重启电脑端（引擎）后生效。
 */
export type NetworkRoute = 'direct' | 'proxy'

export interface NetworkConfig {
  /** Clash 等本地代理地址，如 http://127.0.0.1:7897；空字符串 = 完全不启用代理。 */
  proxyUrl?: string
  /** providerId → 路由；缺省 = 默认（走代理）。 */
  routes?: Record<string, NetworkRoute>
  /** directHosts() 的结果缓存（桥接维护，桌面壳读取）。 */
  noProxyHosts?: string[]
  /** 每次修改 +1，供双端判断「是否需要在重启后刷新」。 */
  revision?: number
  /** 手机端/桌面端请求的「重启电脑端」标记；壳处理完由新引擎清除。 */
  restartRequestedAt?: number | null
}

/** baseURL → 主机名（小写）；解析失败给空串。 */
export function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 需要绕过代理的主机列表：所有被标为 direct 的提供商主机。
 * undici 的 NO_PROXY 匹配「主机名及其子域」，所以只存宿主名即可。
 */
export function directHosts(
  providers: Record<string, string>,
  routes: Record<string, NetworkRoute>,
): string[] {
  const hosts = new Set<string>()
  for (const [provider, route] of Object.entries(routes)) {
    if (route !== 'direct') continue
    const host = hostOf(providers[provider] ?? '')
    if (host !== '') hosts.add(host)
  }
  return [...hosts].sort()
}
