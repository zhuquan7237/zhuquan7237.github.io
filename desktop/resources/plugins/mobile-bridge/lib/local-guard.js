/**
 * `/mobile-local/*` is the desktop-only surface (pairing codes, device list,
 * network config). The engine binds to 127.0.0.1, but a browser page can still
 * reach it through DNS rebinding (attacker domain re-resolved to 127.0.0.1) or a
 * cross-site form POST. Both carry a foreign Host / Origin header, so only
 * loopback Host names — and, when present, loopback Origins — are accepted.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Strip the `:port` from a Host header value (handles bracketed IPv6). */
export function hostnameOf(hostHeader) {
    const value = hostHeader.trim().toLowerCase();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        return end > 0 ? value.slice(0, end + 1) : value;
    }
    const colon = value.indexOf(':');
    return colon >= 0 ? value.slice(0, colon) : value;
}
export function isLoopbackHostHeader(hostHeader) {
    const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (raw === undefined || raw === '')
        return false;
    return LOOPBACK_HOSTS.has(hostnameOf(raw));
}
/** Absent Origin (same-origin GET, curl, the Electron shell) is fine; a present one must be loopback. */
export function isLoopbackOrigin(origin) {
    const raw = Array.isArray(origin) ? origin[0] : origin;
    if (raw === undefined || raw === '')
        return true;
    if (raw === 'null')
        return false;
    try {
        return LOOPBACK_HOSTS.has(new URL(raw).hostname.toLowerCase()) || LOOPBACK_HOSTS.has(`[${new URL(raw).hostname}]`);
    }
    catch {
        return false;
    }
}
export function isLocalRequestAllowed(headers) {
    return isLoopbackHostHeader(headers['host']) && isLoopbackOrigin(headers['origin']);
}
