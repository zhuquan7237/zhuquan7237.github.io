import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compile the actual TS into scratch, not the user's already-modified lib/.
// relay.js is a separate hand-written runtime file; neither relay nor mux is
// exercised by these isolated event-stream tests.
let compiled: string;
let apply: typeof import('../resources/plugins/mobile-bridge/src/index.js').apply;
let emptyStore: typeof import('../resources/plugins/mobile-bridge/src/devices.js').emptyStore;
let newToken: typeof import('../resources/plugins/mobile-bridge/src/devices.js').newToken;
let writeStore: typeof import('../resources/plugins/mobile-bridge/src/devices.js').writeStore;
let decodeFrames: typeof import('../resources/plugins/mobile-bridge/src/ws.js').decodeFrames;
let encodeTextFrame: typeof import('../resources/plugins/mobile-bridge/src/ws.js').encodeTextFrame;

beforeAll(async () => {
  compiled = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'dsh-bridge-compiled-'));
  const require = createRequire(import.meta.url);
  const project = fileURLToPath(new URL('../resources/plugins/mobile-bridge/tsconfig.json', import.meta.url));
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', project, '--outDir', compiled, '--pretty', 'false']);
  writeFileSync(join(compiled, 'package.json'), '{"type":"module"}');
  writeFileSync(join(compiled, 'relay.js'), 'export function startRelayLink() {}');
  writeFileSync(join(compiled, 'mux-client.js'), 'export class QuestionsMuxClient { start() {} stop() {} }');
  const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(compiled, name)).href);
  ({ apply } = await load('index.js'));
  ({ emptyStore, newToken, writeStore } = await load('devices.js'));
  ({ decodeFrames, encodeTextFrame } = await load('ws.js'));
}, 30000);
afterAll(() => { if (compiled) rmSync(compiled, { recursive: true, force: true }); });

class FakeSocket extends EventEmitter {
  frames: any[] = [];
  onFrame?: (frame: any) => void;
  write(data: Buffer | string) {
    if (Buffer.isBuffer(data)) {
      const decoded = decodeFrames(Buffer.alloc(0), data);
      for (const frame of decoded.frames) if (frame.opcode === 1) {
        const value = JSON.parse(frame.payload.toString('utf8'));
        this.frames.push(value);
        this.onFrame?.(value);
      }
    }
    return true;
  }
  end() { this.emit('close'); }
  unshift() {}
}

describe('mobile bridge actual engine-event to WebSocket progress', () => {
  let home: string;
  let events: Map<string, (...args: any[]) => void>;
  let ws: FakeSocket;
  let upgrade: any;
  let authToken: string;
  let currentEpoch: string;
  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'dsh-bridge-events-'));
    vi.stubEnv('DSH_HOME', home);
    vi.stubEnv('DSH_MOBILE_BRIDGE_NO_LAN', '1');
    vi.stubEnv('DSH_MOBILE_BRIDGE_NO_RELAY', '1');
    const auth = newToken();
    authToken = auth.token;
    const store = emptyStore();
    store.devices.push({ id: 'test-device', name: 'test', platform: 'test', tokenHash: auth.tokenHash, scopes: ['read'], createdAt: 1, lastSeenAt: 1 });
    writeStore(store);
    events = new Map();
    const server = { register() {}, registerUpgrade(route: any) { upgrade = route.handler; } };
    const ctx = { get(name: string) { return name === 'webServer' ? server : undefined; }, on(name: string, fn: any) { events.set(name, fn); }, inject() {} };
    apply(ctx as any);
    ws = new FakeSocket();
    upgrade({ url: '/mobile/events?token=' + auth.token, headers: { 'sec-websocket-key': 'test-key', 'sec-websocket-version': '13' } }, ws, Buffer.alloc(0));
    currentEpoch = ws.frames[0].data.server.epoch;
    ws.frames.length = 0;
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  function frame(frame: object) { events.get('agent/assistant-stream')!({ agent: { session: { id: 'session-a' } }, frame }); }
  function progress() { return ws.frames.filter((x) => x.type === 'assistant/progress'); }
  function hello(socket = ws, since = 0, epoch = currentEpoch) {
    socket.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since, epoch })));
  }
  function publish(i: number, type = 'step/start') {
    events.get('session/event')!({ id: 'session-a' }, { type, seq: i, data: {} });
  }
  function connect() {
    const socket = new FakeSocket();
    upgrade({ url: '/mobile/events?token=' + authToken, headers: { 'sec-websocket-key': 'another-key', 'sec-websocket-version': '13' } }, socket, Buffer.alloc(0));
    socket.frames.length = 0;
    return socket;
  }

  it('marks stream start as waiting and flushes first actual reasoning immediately without exposing content', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 4, step: 2 });
    expect(ws.frames).toHaveLength(1);
    expect(ws.frames[0].type).toBe('assistant/waiting');
    expect(ws.frames[0].data).toMatchObject({ phase: 'waiting', textChars: 0, reasoningChars: 0 });
    // Old phones mark every assistant/progress as responded; do not send one yet.
    expect(progress()).toHaveLength(0);
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'reasoning-delta', text: 'secret-thinking' } });
    expect(progress()).toHaveLength(1);
    expect(progress()[0].data).toMatchObject({ phase: 'reasoning', reasoningChars: 15, textChars: 0 });
    expect(JSON.stringify(ws.frames)).not.toContain('secret-thinking');
    expect(ws.frames.some((x) => x.type === 'assistant/chunk')).toBe(false);
  });

  it('recognizes a provider block start and text output without waiting for the one-second heartbeat', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 });
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'block-start', blockType: 'text', index: 0 } });
    expect(progress().at(-1).data.phase).toBe('responding');
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'text-delta', text: 'hello' } });
    expect(progress().at(-1).data).toMatchObject({ phase: 'output', textChars: 5 });
  });

  it('recognizes tool-only upstream responses without leaking tool content', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 });
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'tool-call-delta', name: 'secret-tool', argumentsDelta: 'secret-args' } });
    expect(progress().at(-1).data).toMatchObject({ phase: 'tool', textChars: 0, reasoningChars: 0 });
    expect(JSON.stringify(ws.frames)).not.toMatch(/secret-tool|secret-args/);
  });

  it('does not mistake locally generated error usage and finish chunks for an upstream response', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 });
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'usage', usage: { input: 0, output: 0 } } });
    frame({ type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'finish', reason: { kind: 'error' } } });
    expect(progress()).toHaveLength(0);
    expect(ws.frames.every((x) => x.type === 'assistant/waiting' && x.data.phase === 'waiting')).toBe(true);
  });

  it('does not claim response when an attempt ends before a provider chunk', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 });
    frame({ type: 'end', attemptId: 'session-a:1' });
    expect(progress()).toHaveLength(0);
    expect(ws.frames.every((x) => x.type === 'assistant/waiting' && x.data.phase === 'waiting')).toBe(true);
  });

  it('keeps normal and stale-future listeners in sync across replay and live frames', () => {
    for (let i = 1; i <= 3; i++) events.get('session/event')!({ id: 'session-a' }, { type: 'step/start', seq: i, data: { turn: 1, step: i } });
    const future = new FakeSocket();
    upgrade({ url: '/mobile/events?token=' + authToken, headers: { 'sec-websocket-key': 'second-test-key', 'sec-websocket-version': '13' } }, future, Buffer.alloc(0));
    ws.frames.length = 0; future.frames.length = 0;
    ws.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since: 0 })));
    future.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since: 999999 })));
    expect(ws.frames[0].data).toMatchObject({ gap: false, replay: 3 });
    expect(future.frames[0].data).toMatchObject({ gap: true, replay: 3 });
    events.get('session/event')!({ id: 'session-a' }, { type: 'step/end', seq: 4, data: {} });
    expect(ws.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(future.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });

  it('replays before events published between upgrade and hello without duplicates', () => {
    for (let i = 1; i <= 3; i++) events.get('session/event')!({ id: 'session-a' }, { type: i === 2 ? 'turn/start' : 'step/start', seq: i, data: {} });
    const reconnect = new FakeSocket();
    upgrade({ url: '/mobile/events?token=' + authToken, headers: { 'sec-websocket-key': 'reconnect-key', 'sec-websocket-version': '13' } }, reconnect, Buffer.alloc(0));
    reconnect.frames.length = 0;
    // The notification generated by turn/end is also sequenced (seq 5).
    events.get('session/event')!({ id: 'session-a' }, { type: 'turn/end', seq: 4, data: {} });
    reconnect.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since: 1, epoch: currentEpoch })));
    expect(reconnect.frames[0]).toMatchObject({ kind: 'hello', data: { replay: 4, gap: false } });
    expect(reconnect.frames.filter((x) => x.kind !== 'hello').map((x) => x.seq)).toEqual([2, 3, 4, 5]);
    expect(reconnect.frames.filter((x) => x.kind === 'event').map((x) => x.type)).toEqual(['turn/start', 'step/start', 'turn/end']);
  });

  it.each(['ack', 'replay'])('serializes a synchronous publish during hello %s', (during) => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect();
    let injected = false;
    socket.onFrame = (x) => {
      if (!injected && (during === 'ack' ? x.kind === 'hello' : x.seq === 2 && x.kind === 'event')) {
        injected = true;
        publish(4);
      }
    };
    hello(socket, 1);
    expect(injected).toBe(true);
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it('preserves order across clients when publishing synchronously from a socket write', () => {
    hello(); ws.frames.length = 0;
    const other = connect(); hello(other); other.frames.length = 0;
    let injected = false;
    ws.onFrame = (x) => {
      if (!injected && x.kind === 'event' && x.seq === 1) { injected = true; publish(2); }
    };
    publish(1);
    expect(ws.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([1, 2]);
    expect(other.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([1, 2]);
  });

  it('releases only post-connect frames to a client that never sends hello after 500ms', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const legacy = connect();
    publish(4); publish(5);
    vi.advanceTimersByTime(499);
    expect(legacy.frames.filter((x) => x.kind === 'event')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(legacy.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([4, 5]);
    publish(6);
    expect(legacy.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([4, 5, 6]);
  });

  it('signals a gap rather than replaying behind already delivered fallback frames on a late hello', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect(); publish(4);
    vi.advanceTimersByTime(500);
    hello(socket, 1);
    expect(socket.frames.find((x) => x.kind === 'hello').data).toMatchObject({ gap: true, replay: 0 });
    publish(5);
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([4, 5]);
  });

  it('still permits full replay after fallback if no event was delivered', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect();
    vi.advanceTimersByTime(500);
    hello(socket, 1);
    expect(socket.frames.find((x) => x.kind === 'hello').data).toMatchObject({ gap: false, replay: 2 });
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([2, 3]);
  });

  it('flags a truncated replay and sends the retained ring in order', () => {
    for (let i = 1; i <= 510; i++) publish(i);
    const socket = connect(); hello(socket, 5);
    expect(socket.frames[0].data).toMatchObject({ gap: true, replay: 500 });
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i + 11));
  });

  it('flags truncation for a zero watermark that explicitly names the current epoch', () => {
    for (let i = 1; i <= 505; i++) publish(i);
    const socket = connect(); hello(socket, 0);
    expect(socket.frames[0].data).toMatchObject({ gap: true, replay: 500 });
    expect(socket.frames.filter((x) => x.kind === 'event')[0].seq).toBe(6);
  });

  it('signals a gap if the ring overflows during the legacy grace period', () => {
    const legacy = connect();
    for (let i = 1; i <= 505; i++) publish(i);
    vi.advanceTimersByTime(500);
    expect(legacy.frames[0].data.gap).toBe(true);
    expect(legacy.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i + 6));
  });

  it('reports a new gap if the ring overflows while replay is being written', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect();
    let injected = false;
    socket.onFrame = (x) => {
      if (!injected && x.kind === 'hello') {
        injected = true;
        for (let i = 4; i <= 508; i++) publish(i);
      }
    };
    hello(socket, 1);
    const data = socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq);
    expect(data).toEqual([2, 3, ...Array.from({ length: 500 }, (_, i) => i + 9)]);
    const gapIndex = socket.frames.findIndex((x) => x.kind === 'hello' && x.data.gap);
    expect(gapIndex).toBeGreaterThan(socket.frames.findIndex((x) => x.kind === 'event' && x.seq === 3));
    expect(gapIndex).toBeLessThan(socket.frames.findIndex((x) => x.kind === 'event' && x.seq === 9));
  });

  it('does not advance the cursor with a pong before hello', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect(); publish(4);
    socket.emit('data', encodeTextFrame(JSON.stringify({ type: 'ping' })));
    expect(socket.frames.find((x) => x.title === 'pong').seq).toBe(0);
    hello(socket, 1);
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([2, 3, 4]);
  });

  it('cancels the fallback timer when a pending connection closes', () => {
    const count = vi.getTimerCount();
    const socket = connect();
    expect(vi.getTimerCount()).toBe(count + 1);
    socket.emit('close');
    expect(vi.getTimerCount()).toBe(count);
    vi.advanceTimersByTime(500);
    expect(socket.frames).toEqual([]);
  });

  it('cancels the pending timer when the client sends a WebSocket close frame', () => {
    const count = vi.getTimerCount();
    const socket = connect();
    expect(vi.getTimerCount()).toBe(count + 1);
    socket.emit('data', Buffer.from([0x88, 0]));
    expect(vi.getTimerCount()).toBe(count);
  });

  it('defers a reentrant second hello until the first replay has completed', () => {
    for (let i = 1; i <= 3; i++) publish(i);
    const socket = connect();
    let sent = false;
    socket.onFrame = (x) => {
      if (!sent && x.kind === 'event' && x.seq === 2) { sent = true; hello(socket, 1); }
    };
    hello(socket, 1);
    expect(socket.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([2, 3]);
    expect(socket.frames.filter((x) => x.kind === 'hello').map((x) => x.data.gap)).toEqual([false, true]);
  });

  it('orders the same race over an actual loopback WebSocket', async () => {
    vi.useRealTimers();
    for (let i = 1; i <= 3; i++) publish(i, i === 2 ? 'turn/start' : 'step/start');
    const server = createServer();
    server.on('upgrade', (req, socket, head) => {
      upgrade(req, socket, head);
      // Publish after HTTP upgrade but before the client can send its hello.
      publish(4, 'turn/end');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/mobile/events?token=${authToken}`);
    const received: any[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket replay timed out')), 3000);
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', since: 1, epoch: currentEpoch })));
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket error')); });
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          received.push(message);
          if (message.kind === 'notify' && message.seq === 5) { clearTimeout(timer); resolve(); }
        });
      });
      expect(received.filter((x) => x.kind !== 'hello').map((x) => x.seq)).toEqual([2, 3, 4, 5]);
      expect(received.filter((x) => x.kind === 'event').map((x) => x.type)).toEqual(['turn/start', 'step/start', 'turn/end']);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);

  it('delivers to a no-hello client over a real loopback WebSocket after the grace period', async () => {
    vi.useRealTimers();
    for (let i = 1; i <= 3; i++) publish(i);
    const server = createServer();
    let publishedAt = 0;
    server.on('upgrade', (req, socket, head) => {
      upgrade(req, socket, head);
      publishedAt = Date.now();
      publish(4);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/mobile/events?token=${authToken}`);
    const received: any[] = [];
    try {
      const elapsed = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('legacy fallback timed out')), 3000);
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket error')); });
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          received.push(message);
          if (message.kind === 'event') { clearTimeout(timer); resolve(Date.now() - publishedAt); }
        });
      });
      expect(received.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([4]);
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);

  it('resumes just after the watermark for the current epoch', () => {
    for (let i = 1; i <= 3; i++) events.get('session/event')!({ id: 'session-a' }, { type: 'step/start', seq: i, data: {} });
    ws.frames.length = 0;
    ws.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since: 1, epoch: currentEpoch })));
    expect(ws.frames[0].data).toMatchObject({ gap: false, replay: 2 });
    expect(ws.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([2, 3]);
  });

  it('replays and signals a gap for an old epoch even when its watermark is below the new counter', () => {
    // Unlike since > seq, this old watermark looks numerically valid after restart.
    for (let i = 1; i <= 3; i++) events.get('session/event')!({ id: 'session-a' }, { type: 'step/start', seq: i, data: { turn: 1, step: i } });
    ws.frames.length = 0;
    ws.emit('data', encodeTextFrame(JSON.stringify({ type: 'hello', since: 1, epoch: 'previous-process-epoch' })));
    const ack = ws.frames.find((x) => x.kind === 'hello');
    expect(ack.data).toMatchObject({ gap: true, replay: 3 });
    expect(ws.frames.filter((x) => x.kind === 'event').map((x) => x.seq)).toEqual([1, 2, 3]);
    events.get('session/event')!({ id: 'session-a' }, { type: 'step/end', seq: 4, data: {} });
    expect(ws.frames.at(-1)).toMatchObject({ type: 'step/end', seq: 4 });
  });

  it('ignores a late end from a superseded attempt', () => {
    hello(); ws.frames.length = 0;
    frame({ type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 });
    frame({ type: 'start', attemptId: 'session-a:2', turn: 1, step: 2 });
    frame({ type: 'end', attemptId: 'session-a:1' });
    frame({ type: 'chunk', attemptId: 'session-a:2', chunk: { type: 'text-delta', text: 'ok' } });
    expect(progress().at(-1).data).toMatchObject({ phase: 'output', turn: 1, step: 2, textChars: 2 });
  });
});

describe('mobile bridge sessions over real HTTP', () => {
  let home: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let token: string;
  let calls: Array<{ endpoint: string; args: any }>;
  let failSelection: boolean;

  beforeEach(async () => {
    home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'dsh-bridge-http-'));
    vi.stubEnv('DSH_HOME', home);
    vi.stubEnv('DSH_MOBILE_BRIDGE_NO_LAN', '1');
    vi.stubEnv('DSH_MOBILE_BRIDGE_NO_RELAY', '1');
    const auth = newToken(); token = auth.token;
    const store = emptyStore();
    store.devices.push({ id: 'http-device', name: 'http', platform: 'test', tokenHash: auth.tokenHash, scopes: ['read', 'prompt'], createdAt: 1, lastSeenAt: 1 });
    writeStore(store);

    calls = []; failSelection = false;
    const gateway = {
      async dispatchRpc(endpoint: string, payload: { args: any }) {
        // Mirror the actual 0.2.x descriptors: list names its argument
        // `_request`, while create/selectModel name it `request`.
        const field = endpoint === 'session/list' ? '_request' : 'request';
        if (!(field in payload.args)) return { ok: false, error: { code: 'gateway/bad-request', message: `missing "${field}"` } };
        const args = payload.args[field];
        calls.push({ endpoint, args });
        if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'existing', cwd: 'C:/old' }] } };
        if (endpoint === 'session/create') return { ok: true, value: { sessionId: 'created-session' } };
        if (endpoint === 'session/selectModel') return failSelection
          ? { ok: false, error: { code: 'session/model-unavailable', message: 'model selection rejected' } }
          : { ok: true, value: { selected: { provider: args.provider, model: args.model } } };
        throw new Error(`unexpected endpoint: ${endpoint}`);
      },
    };
    let route: any;
    const webServer = {
      register(entry: any) { if (entry.kind === 'exact' && entry.path === '/mobile/sessions') route = entry.handler; },
      registerUpgrade() {},
    };
    const ctx = { get(name: string) { return name === 'webServer' ? webServer : name === 'typertGateway' ? gateway : undefined; }, on() {}, inject() {} };
    apply(ctx as any);
    if (!route) throw new Error('sessions route not registered');
    server = createServer((req, res) => route(req, res));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    base = `http://127.0.0.1:${address.port}/mobile/sessions`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('serves GET list without a body', async () => {
    const res = await fetch(base, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, items: [{ sessionId: 'existing', cwd: 'C:/old' }] });
    expect(calls).toEqual([{ endpoint: 'session/list', args: {} }]);
  });

  it('creates a default session for a truly empty POST body', async () => {
    const res = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 'created-session' });
    expect(calls).toEqual([{ endpoint: 'session/create', args: {} }]);
  });

  it('passes cwd, agent preset, and model through an HTTP POST', async () => {
    const res = await fetch(base, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ' C:/work/project ', agentPreset: ' custom-preset ', model: { provider: 'test-provider', model: 'test-model' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 'created-session' });
    expect(calls).toEqual([
      { endpoint: 'session/create', args: { cwd: 'C:/work/project', agentPreset: 'custom-preset' } },
      { endpoint: 'session/selectModel', args: { sessionId: 'created-session', provider: 'test-provider', model: 'test-model' } },
    ]);
  });

  it('does not report creation success when the requested model switch fails', async () => {
    failSelection = true;
    const res = await fetch(base, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'C:/work/project', model: { provider: 'test-provider', model: 'test-model' } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: 'E_ENGINE', message: 'model selection rejected' });
    expect(calls).toEqual([
      { endpoint: 'session/create', args: { cwd: 'C:/work/project' } },
      { endpoint: 'session/selectModel', args: { sessionId: 'created-session', provider: 'test-provider', model: 'test-model' } },
    ]);
  });
});
