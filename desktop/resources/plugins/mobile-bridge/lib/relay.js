/**
 * 远程中继客户端：桌面端主动拨出，挂到中继服务器上，让手机从任何网络都能连。
 *
 * 支持多条候选线路并自动切换（candidates 按优先级给）：
 *   1. direct      —— 国内直连 <服务器>:8443（TLS），延迟最低（~30-60ms）
 *   2. cloudflare  —— 走 Cloudflare 隧道，任何地方都通，但国内绕美国边缘（~1.5-2s）
 * 直连连不上（比如安全组没放行 / 换到境外网络）时自动退到下一条；
 * 之后每 10 分钟试着切回第一条，能连通就自动回到最快线路。
 *
 * 与中继的握手帧（JSON）：
 *   {t:'ping'}                                  中继心跳，必须回 {t:'pong'}
 *   {t:'req', id, method, url, headers, body}   一次 HTTP 请求（body 为 base64）
 *   {t:'res', id, status, headers, body}        回给它
 *   {t:'up', id, url} / {t:'up', id, ok}        WebSocket 升级（含 /mobile/events）
 *   {t:'data', id, b64} / {t:'close', id}       WebSocket 双向数据
 */
import { request as httpRequest } from 'node:http';
import net from 'node:net';

const HEADER_DROP = new Set(['host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version',
    'sec-websocket-extensions', 'sec-websocket-protocol', 'content-length']);

/** 稳定超过这么久，就算"这条线路可用"，断了也重连同一条而不是换线路。 */
const STABLE_MS = 20000;

export function startRelayLink({ candidates, deviceKey, secret, localPort, log = () => { } }) {
    const list = (candidates ?? []).filter((item) => item && item.url);
    if (list.length === 0)
        throw new Error('中继线路为空');
    let closed = false;
    let socket = null;
    let index = 0;
    let switching = false;
    let retry = 0;
    let state = 'connecting';
    let openedAt = 0;
    const timers = new Set();
    const channels = new Map();
    const note = (line) => log(`[中继] ${line}`);

    const schedule = () => {
        if (closed)
            return;
        retry += 1;
        const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
        const timer = setTimeout(() => {
            timers.delete(timer);
            connect();
        }, wait);
        timers.add(timer);
    };

    let attempt = 0;
    const connect = async () => {
        if (closed)
            return;
        state = 'connecting';
        const mine = ++attempt;
        const candidate = list[index];
        // 先探一下能不能连上：不可达的地址（比如安全组没放行的直连口）会让 TCP 连接
        // 挂住将近两分钟，期间既连不上也不换线。探测 5 秒不通就直接换下一条。
        if (!(await reachable(candidate))) {
            if (closed)
                return;
            note(`${candidate.label ?? candidate.name} 连不上，换下一条线路`);
            index = (index + 1) % list.length;
            schedule();
            return;
        }
        const url = `${String(candidate.url).replace(/\/+$/, '')}/link?key=${encodeURIComponent(deviceKey)}&secret=${encodeURIComponent(secret)}`;
        try {
            socket = new WebSocket(url);
        }
        catch (error) {
            note(`连接失败：${error instanceof Error ? error.message : String(error)}`);
            schedule();
            return;
        }
        // 看门狗：TCP 探测通过但 WebSocket 握手卡住时（例如 TLS 被中间设备吞了），
        // 12 秒后作废这次尝试并换下一条线路——否则会永远停在 connecting。
        const guard = setTimeout(() => {
            if (closed || mine !== attempt || socket?.readyState === 1)
                return;
            note(`${candidate.label ?? candidate.name} 握手超时，换下一条线路`);
            attempt += 1;
            const stale = socket;
            socket = null;
            try {
                stale?.close();
            }
            catch { /* 已断 */ }
            index = (index + 1) % list.length;
            schedule();
        }, 12000);
        socket.addEventListener('open', () => {
            clearTimeout(guard);
            if (mine !== attempt)
                return;
            retry = 0;
            state = 'online';
            openedAt = Date.now();
            note(`已挂上中继（${candidate.label ?? candidate.name}）`);
        });
        socket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string')
                return;
            let frame;
            try {
                frame = JSON.parse(event.data);
            }
            catch {
                return;
            }
            if (frame.t === 'ping') {
                // 中继靠心跳判活：必须回，否则静默 35s 会被踢掉
                if (socket?.readyState === 1)
                    socket.send(JSON.stringify({ t: 'pong', at: Date.now() }));
            }
            else if (frame.t === 'req') {
                handleRequest(frame);
            }
            else if (frame.t === 'up') {
                handleUpgrade(frame);
            }
            else if (frame.t === 'data' && frame.id) {
                channels.get(frame.id)?.send(frame);
            }
            else if (frame.t === 'close' && frame.id) {
                channels.get(frame.id)?.close();
            }
        });
        socket.addEventListener('close', () => {
            clearTimeout(guard);
            state = 'offline';
            if (closed || mine !== attempt)
                return;
            if (switching)
                switching = false;
            else if (!(openedAt > 0 && Date.now() - openedAt > STABLE_MS))
                index = (index + 1) % list.length;
            schedule();
        });
        socket.addEventListener('error', () => { /* close 会接手 */ });
    };

    const reply = (frame, payload) => {
        if (socket?.readyState === 1)
            socket.send(JSON.stringify({ t: 'res', id: frame.id, ...payload }));
    };

    const handleRequest = (frame) => {
        let target;
        try {
            target = new URL(String(frame.url ?? '/'), `http://127.0.0.1:${localPort}`);
        }
        catch {
            reply(frame, { status: 400, headers: { 'content-type': 'text/plain' }, body: '' });
            return;
        }
        if (!target.pathname.startsWith('/mobile') && !target.pathname.startsWith('/mobile-local')) {
            reply(frame, { status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('只转发手机端接口').toString('base64') });
            return;
        }
        const headers = {};
        for (const [key, value] of Object.entries(frame.headers ?? {})) {
            if (!HEADER_DROP.has(key.toLowerCase()))
                headers[key] = value;
        }
        headers.host = `127.0.0.1:${localPort}`;
        const body = frame.body ? Buffer.from(frame.body, 'base64') : null;
        if (body)
            headers['content-length'] = String(body.length);
        const upstream = httpRequest({
            host: '127.0.0.1', port: localPort, method: frame.method, path: target.pathname + target.search, headers,
        }, (up) => {
            const chunks = [];
            up.on('data', (chunk) => chunks.push(chunk));
            up.on('end', () => reply(frame, {
                status: up.statusCode ?? 502,
                headers: up.headers,
                body: Buffer.concat(chunks).toString('base64'),
            }));
        });
        upstream.on('error', (error) => {
            note(`打到本机桥接失败：${error.message}`);
            reply(frame, { status: 502, headers: { 'content-type': 'text/plain' }, body: '' });
        });
        if (body)
            upstream.write(body);
        upstream.end();
    };

    const handleUpgrade = (frame) => {
        let ws;
        try {
            ws = new WebSocket(`ws://127.0.0.1:${localPort}${frame.url ?? '/'}`);
        }
        catch {
            if (socket?.readyState === 1)
                socket.send(JSON.stringify({ t: 'up', id: frame.id, ok: false }));
            return;
        }
        channels.set(frame.id, {
            send: (data) => {
                if (ws.readyState === 1)
                    ws.send(Buffer.from(data.b64 ?? '', 'base64'));
            },
            close: () => {
                try {
                    ws.close();
                }
                catch { /* 已断 */ }
            },
        });
        ws.addEventListener('open', () => {
            if (socket?.readyState === 1)
                socket.send(JSON.stringify({ t: 'up', id: frame.id, ok: true }));
        });
        ws.addEventListener('message', (event) => {
            const raw = Buffer.from(event.data);
            if (socket?.readyState === 1)
                socket.send(JSON.stringify({ t: 'data', id: frame.id, b64: raw.toString('base64') }));
        });
        ws.addEventListener('close', () => {
            channels.delete(frame.id);
            if (socket?.readyState === 1)
                socket.send(JSON.stringify({ t: 'close', id: frame.id, code: 1000, reason: '' }));
        });
        ws.addEventListener('error', () => { /* close 会接手 */ });
    };

    /** 先探测能不能连上（TCP 层），通了才切——直连没放行时不要每 10 分钟抖一下。 */
    const reachable = (candidate) => new Promise((resolve) => {
        let target;
        try {
            target = new URL(String(candidate.url).replace(/^ws/, 'http'));
        }
        catch {
            resolve(false);
            return;
        }
        const probe = net.connect({
            host: target.hostname,
            port: target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80),
        });
        const done = (ok) => {
            probe.destroy();
            resolve(ok);
        };
        probe.setTimeout(5000, () => done(false));
        probe.on('connect', () => done(true));
        probe.on('error', () => done(false));
    });

    // 每 10 分钟：当前不在首选线路时，探一下首选线路，通了才切回去
    const backTimer = setInterval(() => {
        if (closed || index === 0)
            return;
        void reachable(list[0]).then((ok) => {
            if (closed || index === 0)
                return;
            if (!ok) {
                note(`${list[0].label ?? list[0].name} 暂不可达，继续用当前线路`);
                return;
            }
            note('尝试切回国内直连…');
            index = 0;
            switching = true;
            try {
                socket?.close();
            }
            catch { /* 已断 */ }
        });
    }, 10 * 60 * 1000);
    timers.add(backTimer);

    connect();
    return {
        /** 停掉链路（插件卸载时调用）。 */
        stop: () => {
            closed = true;
            state = 'offline';
            for (const timer of timers)
                clearTimeout(timer);
            try {
                socket?.close();
            }
            catch { /* 已断 */ }
        },
        /** 'online' | 'connecting' | 'offline' */
        status: () => state,
        /** 当前正在用（或正在尝试）的线路：{ name, label, url }。 */
        current: () => list[index],
    };
}
