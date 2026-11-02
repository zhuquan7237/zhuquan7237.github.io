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
    // 中继入口必须直连：手机 → 国内中继(cn.zhuquan.xyz:8443) → 电脑 是主链路，
    // 一旦被塞进本地代理就会绕到海外节点，实测把 12ms 的往返拖成 340ms。
    // 这两个主机与「模型提供商」无关，所以在这里固定加入，不受 routes 影响。
    hosts.add('cn.zhuquan.xyz');
    hosts.add('relay.zhuquan.xyz');
    for (const [provider, route] of Object.entries(routes)) {
        if (route !== 'direct')
            continue;
        const host = hostOf(providers[provider] ?? '');
        if (host !== '')
            hosts.add(host);
    }
    return [...hosts].sort();
}
