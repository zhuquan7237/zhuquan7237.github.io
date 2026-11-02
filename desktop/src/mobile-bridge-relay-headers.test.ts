import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { sanitizeRelayHeaders } from '../resources/plugins/mobile-bridge/lib/relay.js';

/**
 * 回归：中继帧里的 HTTP/2 伪头曾把整个引擎进程打死。
 *
 * 线上实录（0.7.8，2026-11-02）：
 *   fatal uncaught exception: TypeError [ERR_INVALID_HTTP_TOKEN]:
 *     Header name must be a valid HTTP token [":method"]
 *     at handleRequest (mobile-bridge/lib/relay.js:177)
 *     at WebSocket.<anonymous> (mobile-bridge/lib/relay.js:120)
 *   → 引擎连续 3 次异常退出，进入恢复模式，远程链路彻底不可用。
 *
 * 成因：客户端走 HTTP/2 时，Node 的 http2 兼容层把 `:method` / `:path` /
 * `:authority` / `:scheme` 一并放进 `req.headers`；中继原样转发，桌面端把
 * 它们交给 `http.request({ headers })`，`setHeader` 抛错 —— 而这是 WebSocket
 * 事件回调里没人接的 throw。任何浏览器 / PWA / curl 打一次远程页面就能触发。
 */

/** 一份真实 h2 请求帧里的 headers。 */
const h2Headers = {
  ':method': 'GET',
  ':path': '/mobile/meta',
  ':scheme': 'https',
  ':authority': 'cn.zhuquan.xyz:8443',
  'user-agent': 'okhttp/4.12.0',
  'accept-encoding': 'gzip',
  'bad header': 'x',
  cookie: 'dsh-auth=abc',
};

describe('sanitizeRelayHeaders', () => {
  it('会把 HTTP/2 伪头全部丢掉', () => {
    const out = sanitizeRelayHeaders(h2Headers);
    expect(Object.keys(out).filter((name) => name.startsWith(':'))).toEqual([]);
  });

  it('非法头名（含空格）不会漏过去', () => {
    const out = sanitizeRelayHeaders(h2Headers);
    expect(out['bad header']).toBeUndefined();
  });

  it('普通头原样保留', () => {
    const out = sanitizeRelayHeaders(h2Headers);
    expect(out['user-agent']).toBe('okhttp/4.12.0');
    expect(out['accept-encoding']).toBe('gzip');
    expect(out.cookie).toBe('dsh-auth=abc');
  });

  it('过滤结果可以直接交给 http.request（这就是原来崩的那一步）', () => {
    // 只验证能构造出请求对象（setHeader 不抛）。不发包，构造完立刻销毁；
    // 不挂 error 监听的话销毁本身会抛一个无人接的 ECONNREFUSED，把整个文件判失败。
    const build = () => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: 1,
        method: 'GET',
        path: '/mobile/meta',
        headers: sanitizeRelayHeaders(h2Headers),
      });
      request.on('error', () => { /* 故意不发，忽略 */ });
      request.destroy();
    };
    expect(build).not.toThrow();
  });

  it('不过滤时确实会抛 ERR_INVALID_HTTP_TOKEN —— 这条钉住的是缺陷本身', () => {
    // 注意断言的是 error.code 而不是 message：message 是
    // 'Header name must be a valid HTTP token [":method"]'，里面没有错误码。
    let thrown: unknown;
    try {
      httpRequest({ host: '127.0.0.1', port: 1, method: 'GET', path: '/mobile/meta', headers: h2Headers });
    }
    catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe('ERR_INVALID_HTTP_TOKEN');
  });

  it('headers 缺失或为 null 时给出空对象，不抛', () => {
    expect(sanitizeRelayHeaders(undefined)).toEqual({});
    expect(sanitizeRelayHeaders(null)).toEqual({});
  });
});
