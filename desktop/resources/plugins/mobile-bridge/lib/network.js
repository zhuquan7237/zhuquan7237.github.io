/** baseURL → 主机名（小写）；解析失败给空串。 */
export function hostOf(baseUrl) {
    try {
        return new URL(String(baseUrl)).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
/**
 * 需要绕过代理的主机列表：所有被标为 direct 的提供商主机。
 * undici 的 NO_PROXY 匹配「主机名及其子域」，所以只存宿主名即可。
 */
export function directHosts(providers, routes) {
    const hosts = new Set();
    for (const [provider, route] of Object.entries(routes)) {
        if (route !== 'direct')
            continue;
        const host = hostOf(providers[provider] ?? '');
        if (host !== '')
            hosts.add(host);
    }
    return [...hosts].sort();
}
