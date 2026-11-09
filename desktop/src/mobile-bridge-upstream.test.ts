import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { cursorFromError } from '../resources/plugins/mobile-bridge/src/cursor.js';
import { fetchUpstreamJson } from '../resources/plugins/mobile-bridge/src/upstream.js';

/**
 * Regression fences for two 0.2.x engine breaks:
 *   1. history reads: the engine's cursor refusal is "session history cut N
 *      exceeds M" — only "past cursor N" was parsed, so every history request
 *      failed with a raw E_ENGINE until the bridge learned the head.
 *   2. model list pull: the bridge used node:https, which ignores the engine's
 *      proxy dispatcher, so proxied providers timed out after 30 s.
 */
describe('cursorFromError', () => {
  it('reads the 0.2.x history-cut refusal', () => {
    expect(cursorFromError('session history cut 9007199254740991 exceeds 298')).toBe(298);
  });

  it('reads the legacy past-cursor refusal', () => {
    expect(cursorFromError('session page is past cursor 42')).toBe(42);
  });

  it('ignores unrelated errors', () => {
    expect(cursorFromError('boom')).toBeNull();
    expect(cursorFromError('history cut 12')).toBeNull();
    expect(cursorFromError('')).toBeNull();
  });
});

describe('fetchUpstreamJson', () => {
  let server: Server;
  let base = '';
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      seen.push(String(req.headers.authorization ?? ''));
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'a' }] }));
        return;
      }
      if (req.url === '/slow') {
        setTimeout(() => {
          res.writeHead(200);
          res.end('{}');
        }, 1500);
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns status and body and forwards the bearer token', async () => {
    const result = await fetchUpstreamJson(new URL(`${base}/models`), 'secret');
    expect('status' in result && result.status).toBe(200);
    expect('body' in result && result.body).toContain('"a"');
    expect(seen.at(-1)).toBe('Bearer secret');
  });

  it('passes non-2xx responses through untouched', async () => {
    const result = await fetchUpstreamJson(new URL(`${base}/missing`), '');
    expect('status' in result && result.status).toBe(404);
  });

  it('turns a timeout into the user-facing message', async () => {
    const result = await fetchUpstreamJson(new URL(`${base}/slow`), '', 1000);
    expect('error' in result && result.error).toBe('请求上游超时（1 秒）');
  });
});
