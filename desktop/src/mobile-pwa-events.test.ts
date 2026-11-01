import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the actual PWA event reducer, with only its DOM/network dependencies replaced.
const source = readFileSync(join(__dirname, '../resources/plugins/mobile-bridge/app/app.js'), 'utf8');
const reducer = source.slice(source.indexOf('  function applyEvent(frame) {'), source.indexOf('  function connect() {'));
if (!reducer.includes('function chunkIsReasoning')) throw new Error('PWA reducer not found');

function fixture() {
  const state: any = { seq: 0, epoch: '', token: 'test', view: 'chat', session: { sessionId: 'a' }, running: false, thinking: false, live: {}, taskStage: '', textChars: 0, reasoningChars: 0 };
  const calls = { renders: 0, statusUpdates: 0, composer: 0, history: 0, sessions: 0 };
  const context = {
    state,
    renderChat: () => { calls.renders++; },
    renderTaskStatus: () => { calls.statusUpdates++; },
    renderComposer: () => { calls.composer++; },
    renderHeader: () => {},
    loadHistory: async () => { calls.history++; },
    loadSessions: async () => { calls.sessions++; },
    toast: () => {},
  };
  const apply = runInNewContext(`${reducer}\napplyEvent`, context) as (frame: any) => void;
  return { state, calls, apply };
}

describe('mobile PWA live progress and recovery', () => {
  it('treats turn start as waiting, then displays a real reasoning signal', () => {
    const x = fixture();
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1, data: {} });
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('waiting');
    expect(x.state.thinking).toBe(false);
    expect(x.calls.statusUpdates).toBeGreaterThan(0);
    expect(x.calls.renders).toBe(0);
    x.apply({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 2, data: { phase: 'reasoning', reasoningChars: 4, textChars: 0 } });
    expect(x.state.taskStage).toBe('reasoning');
    expect(x.state.reasoningChars).toBe(4);
  });

  it('recognizes old-bridge positive counters, not a zero start pulse', () => {
    const x = fixture();
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1, data: {} });
    x.apply({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 2, data: { textChars: 0, reasoningChars: 0 } });
    expect(x.state.taskStage).toBe('waiting');
    x.apply({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 3, data: { textChars: 5, reasoningChars: 0 } });
    expect(x.state.taskStage).toBe('output');
  });

  it('reports live text without displaying partial reply text', () => {
    const x = fixture();
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1, data: {} });
    x.apply({ kind: 'event', sessionId: 'a', type: 'assistant/chunk', seq: 2, data: { chunk: 'partial-secret' } });
    expect(x.state.taskStage).toBe('output');
    expect(Object.keys(x.state.live)).toHaveLength(0);
    expect(JSON.stringify(x.state)).not.toContain('partial-secret');
  });

  it('refreshes history after a turn ends', () => {
    const x = fixture();
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1, data: {} });
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2, data: {} });
    expect(x.state.running).toBe(false);
    expect(x.calls.history).toBe(1);
  });

  it('resets stale replay cursor and refreshes after an epoch changes', () => {
    const x = fixture();
    x.state.seq = 90; x.state.epoch = 'old-process';
    x.apply({ kind: 'hello', seq: 2, data: { server: { epoch: 'new-process' }, gap: true } });
    expect(x.state.epoch).toBe('new-process');
    // The advertised seq is a server high-water mark, not a delivered event.
    // Wait for replay; advancing now could skip frames if the socket drops mid-replay.
    expect(x.state.seq).toBe(0);
    expect(x.calls.history).toBe(1);
    x.apply({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1, data: {} });
    expect(x.state.seq).toBe(1);
  });

  it('does not advance the delivered watermark on a same-epoch handshake', () => {
    const x = fixture();
    x.state.seq = 5; x.state.epoch = 'current-process';
    x.apply({ kind: 'hello', seq: 10, data: { server: { epoch: 'current-process' }, replay: 0, gap: false } });
    expect(x.state.seq).toBe(5);
  });
});

describe('mobile PWA connection recovery', () => {
  it('cancels an old reconnect timer when visibility reconnects early', async () => {
    const start = source.indexOf('  function connect() {');
    const connectSrc = source.slice(start, source.indexOf('  // ------------------------------------------------------------------ sessions', start));
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const sockets: any[] = [];
    class FakeSocket {
      readyState = 0; onopen: any; onclose: any; onmessage: any; onerror: any; closeCalls = 0;
      constructor(_url: string) { sockets.push(this); }
      send(_msg: string) {}
      close() { this.closeCalls++; this.readyState = 3; this.onclose?.(); }
    }
    const state: any = { token: 'test', ws: null, retry: 0, seq: 0, epoch: '', connected: false, reconnectTimer: null };
    const ctx = { state, WebSocket: FakeSocket, WS_URL: () => 'ws://test', renderHeader: () => {}, applyEvent: () => {}, setTimeout: (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id) };
    const connect = runInNewContext(`${connectSrc}\nconnect`, ctx) as () => void;
    connect();
    sockets[0].readyState = 3; sockets[0].onclose();
    expect(timers.size).toBe(1);
    connect(); // visibilitychange, before the delayed timer fires
    sockets[1].readyState = 1; sockets[1].onopen();
    for (const callback of [...timers.values()]) callback();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].closeCalls).toBe(0);
    expect(state.connected).toBe(true);
  });
});

describe('mobile PWA send state', () => {
  it('never submits a stop request before an in-flight prompt is acknowledged', async () => {
    const start = source.indexOf('  async function cancelTurn()');
    expect(start).toBeGreaterThanOrEqual(0);
    const code = source.slice(start, source.indexOf('  // ------------------------------------------------------------------- settings', start));
    let calls = 0, message = '';
    const state: any = { session: { sessionId: 'a' }, sending: true, running: true };
    const fn = runInNewContext(`${code}\ncancelTurn`, { state, api: async () => { calls++; }, API: { sessions: '/mobile/sessions' }, toast: (s:string) => {message=s;} }) as () => Promise<void>;
    await fn();
    expect(calls).toBe(0);
    expect(message).toContain('正在提交');
    state.sending = false;
    await fn();
    expect(calls).toBe(1);
  });
  it('preserves a rejected draft when another turn changed during the request', async () => {
    const start = source.indexOf('  async function send()');
    const code = source.slice(start, source.indexOf('  // ------------------------------------------------------------------- settings', start));
    let reject!: (error: Error) => void;
    const request = new Promise((_resolve, fail) => { reject = fail; });
    const input: any = { value: '原始草稿' }, view: any = { insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 10 };
    const state: any = { session: { sessionId: 'a' }, running: false, draft: '', failedDrafts: {}, taskStage: '', turnVersion: 0, view: 'chat' };
    const fn = runInNewContext(`${code}\nsend`, { state, el: (name:string) => name === 'input' ? input : view, api: () => request, API: { sessions: '/mobile/sessions' }, renderComposer: () => {}, renderChat: () => {}, escapeHtml: (s:string) => s, toast: () => {} }) as () => Promise<void>;
    const pending = fn();
    state.turnVersion++; state.running = true;
    reject(new Error('rejected')); await pending;
    expect(input.value).toContain('原始草稿');
    expect(state.running).toBe(true);
  });
  it('still queues a new message during an existing turn without changing the current progress', async () => {
    const start = source.indexOf('  async function send()');
    const send = source.slice(start, source.indexOf('  // ------------------------------------------------------------------- settings', start));
    const input: any = { value: '下一条' };
    const view: any = { insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 10 };
    const state: any = { session: { sessionId: 'a' }, running: true, sending: false, draft: '', taskStage: 'reasoning', turnVersion: 3, view: 'chat' };
    let calls = 0;
    const fn = runInNewContext(`${send}\nsend`, { state, el: (name: string) => name === 'input' ? input : view, api: async () => { calls++; return { ok: true }; }, API: { sessions: '/mobile/sessions' }, renderComposer: () => {}, renderChat: () => {}, loadHistory: async () => {}, escapeHtml: (s: string) => s, toast: () => {} }) as () => Promise<void>;
    await fn();
    expect(calls).toBe(1);
    expect(state.running).toBe(true);
    expect(state.taskStage).toBe('reasoning');
  });
  it('shows submitting immediately and does not revive an already finished turn on late acknowledgement', async () => {
    const start = source.indexOf('  async function send()');
    const send = source.slice(start, source.indexOf('  // ------------------------------------------------------------------- settings', start));
    expect(send).toContain('async function send()');
    let acknowledge!: (value: any) => void;
    const request = new Promise((resolve) => { acknowledge = resolve; });
    const input: any = { value: '测试消息' };
    const view: any = { insertAdjacentHTML() {}, scrollTop: 0, scrollHeight: 10 };
    const state: any = { session: { sessionId: 'a' }, running: false, draft: '', taskStage: '', turnVersion: 0, textChars: 0, reasoningChars: 0, thinking: false, view: 'chat' };
    const fn = runInNewContext(`${send}\nsend`, { state, el: (name: string) => name === 'input' ? input : view, api: () => request, API: { sessions: '/mobile/sessions' }, renderComposer: () => {}, renderChat: () => {}, loadHistory: async () => {}, escapeHtml: (s: string) => s, toast: () => {} }) as () => Promise<void>;
    const pending = fn();
    expect(state.running).toBe(true);
    expect(state.taskStage).toBe('submitting');
    // The WS may deliver start and end before the HTTP acknowledgement returns.
    state.turnVersion += 2; state.running = false; state.taskStage = '';
    acknowledge({ ok: true });
    await pending;
    expect(state.running).toBe(false);
  });
});

// Run the production fetch, history, event, session, and send functions together.
// Only the browser DOM and the network boundary are replaced.
function integratedFixture() {
  const apiStart = source.indexOf('  async function api(');
  const apiCode = source.slice(apiStart, source.indexOf('  function toast(', apiStart));
  const sessionStart = source.indexOf('  async function openSession(');
  const sessionEnd = source.indexOf('  /**', source.indexOf('  async function loadHistory(', sessionStart));
  const sessionCode = source.slice(sessionStart, sessionEnd);
  const sendStart = source.indexOf('  async function send()');
  const sendCode = source.slice(sendStart, source.indexOf('  // ------------------------------------------------------------------- settings', sendStart));
  for (const [name, code] of [['api', apiCode], ['sessions', sessionCode], ['send', sendCode]]) {
    if (!code.includes(`function ${name === 'sessions' ? 'loadHistory' : name}(`)) throw new Error(`PWA ${name} not found`);
  }

  const state: any = {
    token: 'test-token', seq: 0, epoch: '', session: { sessionId: 'a' }, sessions: [], view: 'chat',
    history: [], historyRequestId: 0, live: {}, running: false, sending: false, thinking: false,
    draft: '', failedDrafts: {}, taskStage: '', textChars: 0, reasoningChars: 0, turnVersion: 0,
  };
  const input = { value: '' };
  const view = { insertAdjacentHTML() {}, querySelector() { return null; }, scrollTop: 0, scrollHeight: 10 };
  const toasts: string[] = [];
  const renders = { count: 0 };
  const requests: Array<{ path: string; options: any; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const fetch = (path: string, options: any) => new Promise<Response>((resolve, reject) => requests.push({ path, options, resolve, reject }));
  const ctx = {
    state, fetch, API: { sessions: '/mobile/sessions' }, el: (name: string) => name === 'input' ? input : view,
    renderChat: () => { renders.count++; }, renderComposer: () => {}, renderTaskStatus: () => {}, renderHeader: () => {},
    loadSessions: async () => {}, toast: (message: string) => toasts.push(message), escapeHtml: (text: string) => text,
    forget: async () => { state.token = null; }, window: { history: { pushState() {} } },
  };
  const functions = runInNewContext(`${apiCode}\n${reducer}\n${sessionCode}\n${sendCode}\n({ api, send, cancelTurn, loadHistory, openSession, applyEvent })`, ctx) as {
    api: (path: string, options?: any) => Promise<any>;
    send: () => Promise<void>;
    cancelTurn: () => Promise<void>;
    loadHistory: (id: string) => Promise<void>;
    openSession: (id: string) => Promise<void>;
    applyEvent: (frame: any) => void;
  };
  return { state, input, toasts, requests, renders, ...functions };
}

function response(status: number, body: string) {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function historyResponse(type: 'turn/start' | 'turn/end') {
  return response(200, JSON.stringify({ ok: true, items: [{ event: { type } }] }));
}

describe('mobile PWA actual API, send and history integration', () => {
  it.each([
    ['empty', ''],
    ['non-JSON with sensitive body', '<html>PRIVATE_RELAY_SECRET</html>'],
    ['JSON error with sensitive body', '{"ok":false,"message":"PRIVATE_RELAY_SECRET"}'],
    ['misleading JSON success', '{"ok":true,"message":"PRIVATE_RELAY_SECRET"}'],
  ])('restores an unconfirmed draft on HTTP 502 (%s) without displaying the body', async (_case, body) => {
    const x = integratedFixture();
    x.input.value = '原始草稿';
    const pending = x.send();
    expect(x.input.value).toBe('');
    expect(x.requests[0].path).toBe('/mobile/sessions/a/prompt');
    expect(x.requests[0].options.method).toBe('POST');
    expect(JSON.parse(x.requests[0].options.body)).toEqual({ text: '原始草稿', mode: 'queue' });
    expect(x.requests[0].options.headers.authorization).toBe('Bearer test-token');
    x.input.value = '新编辑';
    x.requests[0].resolve(response(502, body));
    await pending;
    expect(x.input.value).toBe('原始草稿\n\n新编辑');
    expect(x.state.running).toBe(false);
    expect(x.state.sending).toBe(false);
    expect(x.toasts.join(' ')).toContain('502');
    expect(x.toasts.join(' ')).toContain('请先核对电脑端');
    expect(x.toasts.join(' ')).not.toContain('PRIVATE_RELAY_SECRET');
  });

  it.each([300, 400, 403, 500, 503])('rejects HTTP %s regardless of a JSON success body', async (status) => {
    const x = integratedFixture();
    const pending = x.api('/mobile/test');
    x.requests[0].resolve(response(status, '{"ok":true,"message":"PRIVATE_RELAY_SECRET"}'));
    await expect(pending).rejects.toThrow(`HTTP ${status}`);
  });

  it('forgets the token and restores the draft for a 401 response', async () => {
    const x = integratedFixture();
    x.input.value = '重新配对前的草稿';
    const pending = x.send();
    x.requests[0].resolve(response(401, 'PRIVATE_RELAY_SECRET'));
    await pending;
    expect(x.state.token).toBeNull();
    expect(x.input.value).toBe('重新配对前的草稿');
    expect(x.toasts.join(' ')).toContain('令牌已失效');
    expect(x.toasts.join(' ')).not.toContain('PRIVATE_RELAY_SECRET');
  });

  it('restores the draft after a network rejection with a duplicate-send warning', async () => {
    const x = integratedFixture();
    x.input.value = '断网草稿';
    const pending = x.send();
    x.requests[0].reject(new Error('网络错误'));
    await pending;
    expect(x.input.value).toBe('断网草稿');
    expect(x.state.running).toBe(false);
    expect(x.toasts.join(' ')).toContain('请先核对电脑端');
  });

  it('preserves structured application errors needed by the settings conflict handler', async () => {
    const x = integratedFixture();
    const pending = x.api('/mobile/models');
    x.requests[0].resolve(response(200, '{"ok":false,"code":"E_REVISION","message":"冲突","doc":{"revision":2}}'));
    const error = await pending.then(() => null, (e: any) => e);
    expect(error.code).toBe('E_REVISION');
    expect(error.payload.doc.revision).toBe(2);
  });

  it('preserves a draft when the server replies 200 without an explicit acknowledgement', async () => {
    const x = integratedFixture();
    x.input.value = '未经确认的消息';
    const pending = x.send();
    x.requests[0].resolve(response(200, ''));
    await pending;
    expect(x.input.value).toBe('未经确认的消息');
    expect(x.toasts.join(' ')).toContain('未确认');
  });

  it('keeps the draft and error information for a 200 JSON application error', async () => {
    const x = integratedFixture();
    x.input.value = '失败草稿';
    const pending = x.send();
    x.requests[0].resolve(response(200, JSON.stringify({ ok: false, code: 'E_BAD_REQUEST', message: '消息被拒绝' })));
    await pending;
    expect(x.input.value).toBe('失败草稿');
    expect(x.state.running).toBe(false);
    expect(x.toasts.join(' ')).toContain('消息被拒绝');
    expect(x.toasts.join(' ')).toContain('请先核对电脑端');
  });

  it('does not expose a non-JSON 200 response body in an error', async () => {
    const x = integratedFixture();
    const pending = x.api('/mobile/test');
    x.requests[0].resolve(response(200, 'PRIVATE_RELAY_SECRET'));
    await expect(pending).rejects.not.toThrow('PRIVATE_RELAY_SECRET');
  });

  it('accepts an earlier successful snapshot while a later slow request remains pending', async () => {
    const x = integratedFixture();
    const first = x.loadHistory('a');
    const later = x.loadHistory('a');
    x.requests[0].resolve(response(200, JSON.stringify({ok:true, items:[{event:{type:'user/message',data:{text:'已抵达'}}}]})));
    await first;
    expect(x.state.history[0]?.event?.data?.text).toBe('已抵达');
    x.requests[1].resolve(response(200, JSON.stringify({ok:true, items:[{event:{type:'user/message',data:{text:'更新'}}}]})));
    await later;
    expect(x.state.history[0]?.event?.data?.text).toBe('更新');
  });

  it('ignores an in-flight snapshot from an earlier visit to the same session', async () => {
    const x = integratedFixture();
    const firstVisit = x.openSession('a');
    const other = x.openSession('b');
    const secondVisit = x.openSession('a');
    x.requests[0].resolve(response(200, JSON.stringify({ok:true, items:[{event:{type:'user/message',data:{text:'旧访问'}}}]})));
    await firstVisit;
    expect(x.state.history).toEqual([]);
    x.requests[1].resolve(historyResponse('turn/end'));
    x.requests[2].resolve(response(200, JSON.stringify({ok:true, items:[{event:{type:'user/message',data:{text:'新访问'}}}]})));
    await Promise.all([other, secondVisit]);
    expect(x.state.history[0]?.event?.data?.text).toBe('新访问');
  });

  it('keeps an optimistic message visible when an old history reply arrives during submission', async () => {
    const x = integratedFixture();
    const oldHistory = x.loadHistory('a');
    x.input.value = '等待确认的新消息';
    const pending = x.send();
    const initialRenders = x.renders.count;
    x.requests[0].resolve(historyResponse('turn/end'));
    await oldHistory;
    expect(x.renders.count).toBe(initialRenders);
    x.requests[1].resolve(response(200, '{"ok":true}'));
    await pending;
    // Re-read after acknowledgement: any history that completed during the
    // submit was deliberately not painted over the optimistic user message.
    expect(x.requests[2]?.path).toContain('/sessions/a/history');
    x.requests[2].resolve(response(200, JSON.stringify({ok:true, items:[{event:{type:'user/message',data:{text:'等待确认的新消息'}}}]})));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Paint the successful deferred snapshot at ACK, then the fresh snapshot.
    expect(x.renders.count).toBe(initialRenders + 2);
    expect(x.state.history[0]?.event?.data?.text).toBe('等待确认的新消息');
  });

  it('does not let an older ended history snapshot stop a submitted turn before acknowledgement', async () => {
    const x = integratedFixture();
    const oldHistory = x.loadHistory('a');
    x.input.value = '新一轮';
    const pending = x.send();
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('submitting');
    x.requests[0].resolve(historyResponse('turn/end'));
    await oldHistory;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('submitting');
    x.requests[1].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('waiting');
  });

  it('does not let history requested during submission end a turn when the acknowledgement arrives', async () => {
    const x = integratedFixture();
    x.input.value = '新一轮';
    const pending = x.send();
    const history = x.loadHistory('a');
    x.requests[1].resolve(historyResponse('turn/end'));
    await history;
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('waiting');
  });

  it('keeps newer same-session progress when the HTTP acknowledgement arrives', async () => {
    const x = integratedFixture();
    x.input.value = '开始';
    const pending = x.send();
    x.applyEvent({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'reasoning', reasoningChars: 7 } });
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('reasoning');
    expect(x.state.reasoningChars).toBe(7);
  });

  it('keeps newer same-session progress when the HTTP request fails', async () => {
    const x = integratedFixture();
    x.input.value = '未确认消息';
    const pending = x.send();
    x.applyEvent({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'output', textChars: 11 } });
    x.requests[0].resolve(response(200, '{"ok":false,"message":"未确认"}'));
    await pending;
    expect(x.input.value).toBe('未确认消息');
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('output');
    expect(x.state.textChars).toBe(11);
  });

  it('does not let history started during submission erase newer progress', async () => {
    const x = integratedFixture();
    x.input.value = '新消息';
    const pending = x.send();
    const oldHistory = x.loadHistory('a');
    x.applyEvent({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'reasoning', reasoningChars: 4 } });
    x.requests[1].resolve(historyResponse('turn/end'));
    await oldHistory;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('reasoning');
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('reasoning');
  });

  it.each([
    ['waiting', { type: 'assistant/waiting' }, 'waiting'],
    ['text chunk', { type: 'assistant/chunk', data: { chunk: 'new' } }, 'output'],
    ['tool call', { type: 'tool/call' }, 'tool'],
  ])('preserves a newer %s event when submission is rejected', async (_case, event, expectedStage) => {
    const x = integratedFixture();
    x.input.value = '草稿';
    const pending = x.send();
    x.applyEvent({ kind: 'event', sessionId: 'a', seq: 1, ...event });
    x.requests[0].resolve(response(200, '{"ok":false,"message":"未确认"}'));
    await pending;
    expect(x.input.value).toBe('草稿');
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe(expectedStage);
    if (x.requests[1]) x.requests[1].resolve(historyResponse('turn/start'));
  });

  it('invalidates older history when queueing during an already running turn', async () => {
    const x = integratedFixture();
    x.state.running = true;
    x.state.taskStage = 'reasoning';
    const oldHistory = x.loadHistory('a');
    x.input.value = '排队的消息';
    const pending = x.send();
    x.requests[0].resolve(historyResponse('turn/end'));
    await oldHistory;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('reasoning');
    x.requests[1].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.taskStage).toBe('reasoning');
  });

  it('does not revive a turn that started and ended before its acknowledgement', async () => {
    const x = integratedFixture();
    x.input.value = '很快完成';
    const pending = x.send();
    x.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1 });
    x.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2 });
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(false);
    expect(x.state.taskStage).toBe('');
    x.requests[1].resolve(historyResponse('turn/end'));
  });

  it('renders session B history while a send to session A remains pending', async () => {
    const x = integratedFixture();
    x.input.value = '发给 A';
    const pending = x.send();
    const opened = x.openSession('b');
    x.requests[1].resolve(historyResponse('turn/end'));
    await opened;
    expect(x.renders.count).toBe(1);
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.session.sessionId).toBe('b');
  });

  it('refreshes a completed turn whose history arrived before the send acknowledgement', async () => {
    const x = integratedFixture();
    x.input.value = '快速任务';
    const pending = x.send();
    x.applyEvent({kind:'event',sessionId:'a',type:'turn/start',seq:1});
    x.applyEvent({kind:'event',sessionId:'a',type:'turn/end',seq:2});
    x.requests[1].resolve(historyResponse('turn/end'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(x.renders.count).toBe(0);
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.state.running).toBe(false);
    expect(x.requests[2]?.path).toContain('/sessions/a/history');
    x.requests[2].resolve(response(200, JSON.stringify({ok:true,items:[{event:{type:'assistant/message',data:{text:'完成'}}}]})));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(x.renders.count).toBe(2);
    expect(x.state.history[0]?.event?.data?.text).toBe('完成');
  });

  it('does not change session B when an earlier session A send succeeds', async () => {
    const x = integratedFixture();
    x.input.value = '发给 A';
    const pending = x.send();
    const opened = x.openSession('b');
    x.requests[1].resolve(historyResponse('turn/start'));
    await opened;
    x.applyEvent({ kind: 'event', sessionId: 'b', type: 'assistant/progress', seq: 1, data: { phase: 'output', textChars: 5 } });
    x.requests[0].resolve(response(200, '{"ok":true}'));
    await pending;
    expect(x.requests[0].path).toBe('/mobile/sessions/a/prompt');
    expect(x.state.session.sessionId).toBe('b');
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('output');
    expect(x.state.textChars).toBe(5);
  });

  it('stores an A failure for A without changing B and restores it on return', async () => {
    const x = integratedFixture();
    x.input.value = '发给 A 的草稿';
    const pending = x.send();
    const opened = x.openSession('b');
    x.requests[1].resolve(historyResponse('turn/start'));
    await opened;
    x.applyEvent({ kind: 'event', sessionId: 'b', type: 'assistant/progress', seq: 1, data: { phase: 'output', textChars: 5 } });
    x.requests[0].resolve(response(502, ''));
    await pending;
    expect(x.state.session.sessionId).toBe('b');
    expect(x.input.value).toBe('');
    expect(x.state.failedDrafts.a).toBe('发给 A 的草稿');
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe('output');
    const returned = x.openSession('a');
    expect(x.input.value).toBe('发给 A 的草稿');
    x.requests[2].resolve(historyResponse('turn/end'));
    await returned;
    expect(x.state.session.sessionId).toBe('a');
  });

  it.each([
    ['waiting', { type: 'assistant/waiting' }, 'waiting'],
    ['progress', { type: 'assistant/progress', data: { phase: 'reasoning', reasoningChars: 4 } }, 'reasoning'],
    ['chunk', { type: 'assistant/chunk', data: { chunk: 'text' } }, 'output'],
  ])('recovers running from history after %s arrives before initial recovery', async (_case, event, stage) => {
    const x = integratedFixture();
    const pending = x.loadHistory('a');
    x.applyEvent({ kind: 'event', sessionId: 'a', seq: 1, ...event });
    x.requests[0].resolve(historyResponse('turn/start'));
    await pending;
    expect(x.state.running).toBe(true);
    expect(x.state.taskStage).toBe(stage);
  });

  it('ignores another session event while accepting the active session history', async () => {
    const x = integratedFixture();
    const pending = x.loadHistory('a');
    x.applyEvent({ kind: 'event', sessionId: 'b', type: 'turn/end', seq: 1 });
    x.requests[0].resolve(historyResponse('turn/start'));
    await pending;
    expect(x.state.running).toBe(true);
  });
});

describe('mobile PWA history state', () => {
  it('does not paint a previous session running while switching to a different session', async () => {
    const start = source.indexOf('  async function openSession(');
    const end = source.indexOf('  async function loadHistory(', start);
    const fnSource = source.slice(start, end);
    expect(fnSource).toContain('function openSession');
    const state: any = { sessions: [], session: { sessionId: 'a' }, running: true, taskStage: 'output', textChars: 10, reasoningChars: 0, view: 'chat', history: [], live: {} };
    const fn = runInNewContext(`${fnSource}\nopenSession`, { state, loadHistory: async () => {}, window: { history: { pushState() {} } } }) as (id: string) => Promise<void>;
    await fn('b');
    expect(state.running).toBe(false);
    expect(state.taskStage).toBe('');
  });
  it('does not navigate back to the old session when its slower history request finishes last', async () => {
    const start = source.indexOf('  async function openSession(');
    const fnSource = source.slice(start, source.indexOf('  async function loadHistory(', start));
    const state: any = { sessions: [], session: null, running: false, taskStage: '', textChars: 0, reasoningChars: 0, view: 'sessions', history: [], live: {} };
    const resolves: Record<string, () => void> = {};
    const loads = (id:string) => new Promise<void>((resolve) => { resolves[id] = resolve; });
    const pushed: string[] = [];
    const fn = runInNewContext(`${fnSource}\nopenSession`, { state, loadHistory: loads, window: { history: { pushState(_state:any,_title:any,url:string) { pushed.push(url); } } } }) as (id:string) => Promise<void>;
    const old = fn('a');
    const current = fn('b');
    resolves.b(); await current;
    resolves.a(); await old;
    expect(pushed.at(-1)).toBe('#s=b');
  });
  it('never replaces newer history with an older delayed response for the same session', async () => {
    const start = source.indexOf('  async function loadHistory(');
    const loadHistory = source.slice(start, source.indexOf('  /**', start));
    const state: any = { history: [], historyRequestId: 0, seq: 3, running: false, taskStage: '', view: 'chat', session: { sessionId: 'a' } };
    const resolves: Array<(value: any) => void> = [];
    const api = () => new Promise((resolve) => resolves.push(resolve));
    const fn = runInNewContext(`${loadHistory}\nloadHistory`, { state, api, API: { sessions: '/mobile/sessions' }, renderChat: () => {}, toast: () => {} }) as (id: string) => Promise<void>;
    const slow = fn('a'), fast = fn('a');
    resolves[1]({ items: [{ event: { type: 'turn/end', data: { text: 'new' } } }] });
    await fast;
    resolves[0]({ items: [{ event: { type: 'turn/start', data: { text: 'old' } } }] });
    await slow;
    expect(state.history[0].event.data.text).toBe('new');
    expect(state.running).toBe(false);
  });
  it('restores current session running state when another session emits during history fetch', async () => {
    const start = source.indexOf('  async function loadHistory(');
    const loadHistory = source.slice(start, source.indexOf('  /**', start));
    const state: any = { history: [], historyRequestId: 0, seq: 1, turnVersion: 4, running: false, taskStage: '', view: 'chat', session: { sessionId: 'a' } };
    let respond!: (value: any) => void;
    const pending = new Promise((resolve) => { respond = resolve; });
    const ctx = { state, api: () => pending, API: { sessions: '/mobile/sessions' }, renderChat: () => {}, renderTaskStatus: () => {}, renderComposer: () => {}, loadSessions: () => {}, toast: () => {} };
    const fns = runInNewContext(`${reducer}\n${loadHistory}\n({applyEvent,loadHistory})`, ctx) as { applyEvent: (f:any)=>void; loadHistory:(id:string)=>Promise<void> };
    const request = fns.loadHistory('a');
    fns.applyEvent({ kind: 'event', sessionId: 'b', type: 'turn/end', seq: 2, data: {} });
    respond({ items: [{ event: { type: 'turn/start' } }] });
    await request;
    expect(state.running).toBe(true);
  });
  it('recognizes the last start as running even after a previous turn ended', async () => {
    const start = source.indexOf('  async function loadHistory(');
    const loadHistory = source.slice(start, source.indexOf('  /**', start));
    expect(loadHistory).toContain('function loadHistory');
    const state: any = { history: [], running: false, view: 'chat', session: { sessionId: 'a' } };
    const api = async () => ({ items: [{ event: { type: 'turn/start' } }, { event: { type: 'turn/end' } }, { event: { type: 'turn/start' } }] });
    const fn = runInNewContext(`${loadHistory}\nloadHistory`, { state, api, API: { sessions: '/mobile/sessions' }, renderChat: () => {}, toast: () => {} }) as (id: string) => Promise<void>;
    await fn('a');
    expect(state.running).toBe(true);
  });
});
