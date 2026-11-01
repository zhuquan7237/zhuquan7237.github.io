import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Run the entire production PWA closure, replacing only browser/network APIs.
const source = readFileSync(join(__dirname, '../resources/plugins/mobile-bridge/app/app.js'), 'utf8').replace(/\r\n/g, '\n');
const startup = source.indexOf('  (async () => {\n    state.token = await idb.get');
if (startup < 0) throw new Error('PWA initialization not found');
const end = source.indexOf('\n})();', startup);
const initialization = source.slice(startup, end)
  .replace('  (async () => {', '  async function initialize() {')
  .replace(/\}\)\(\);\s*$/, '}');
const code = source.slice(0, startup) + initialization + '\n  globalThis.app = { state, idb, initialize, api, send, cancelTurn, openSession, loadHistory, applyEvent, connect, renderComposer };\n})();';

type Request = { path: string; options: any; resolve: (value: Response) => void; reject: (error: Error) => void };
const json = (items: any[]) => new Response(JSON.stringify({ ok: true, items }), { status: 200 });
const ack = () => new Response('{"ok":true}', { status: 200 });
const ended = () => json([{ event: { type: 'turn/end' } }]);
const running = () => json([{ event: { type: 'turn/start' } }]);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ok = (data: any) => new Response(JSON.stringify({ ok: true, ...data }), { status: 200 });

async function respondAt(x: ReturnType<typeof fixture>, index: number, response: Response) {
  for (let i = 0; i < 20 && !x.requests[index]; i++) await tick();
  expect(x.requests[index], `request ${index} must exist`).toBeDefined();
  x.requests[index].resolve(response);
}

async function pairAgain(x: ReturnType<typeof fixture>, start: number) {
  x.node('pair-code').value = 'FAKE-CODE';
  x.node('pair-name').value = 'test device';
  const pairing = x.node('pair-go').onclick();
  await respondAt(x, start, ok({ token: 'replacement-token', device: { id: 'test' } }));
  await respondAt(x, start + 1, ok({ device: { id: 'test' }, server: {} }));
  await respondAt(x, start + 2, json([{ sessionId: 'a' }]));
  await pairing;
  const opened = x.app.openSession('a');
  await respondAt(x, start + 3, ended());
  await opened;
}

function fixture(store = new Map<string, any>(), options: { deleteFails?: boolean; deferDraftWrites?: boolean } = {}) {
  const draftWrites: { value: any; commit: () => void }[] = [];
  const sockets: any[] = [];
  class FakeSocket {
    readyState = 0;
    onopen: any; onclose: any; onmessage: any; onerror: any;
    sent: any[] = [];
    constructor(public url: string) { sockets.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(frame: any) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  const nodes = new Map<string, any>();
  const node = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', scrollHeight: 10, scrollTop: 0, style: {},
      insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    });
    return nodes.get(id);
  };
  // IndexedDB API replacement keeps a real shared persistent map across reloads.
  const indexedDB = { open() {
    const request: any = {};
    const db = { transaction() {
      const tx: any = { objectStore() { return {
        get(key: string) { const r: any = {}; queueMicrotask(() => { r.result = structuredClone(store.get(key)); r.onsuccess?.(); }); return r; },
        put(value: any, key: string) {
          // Like IndexedDB, snapshot at put time; delayed commits must never
          // share the application's mutable object by reference.
          const snapshot = structuredClone(value);
          const commit = () => { store.set(key, snapshot); queueMicrotask(() => tx.oncomplete?.()); };
          if (key === 'drafts' && options.deferDraftWrites) draftWrites.push({ value: snapshot, commit });
          else commit();
        },
        delete(key: string) { if (!options.deleteFails) store.delete(key); queueMicrotask(() => options.deleteFails ? tx.onerror?.() : tx.oncomplete?.()); },
      }; } };
      return tx;
    }, createObjectStore() {} };
    queueMicrotask(() => { request.result = db; request.onsuccess?.(); });
    return request;
  } };
  const requests: Request[] = [];
  const fetch = (path: string, options: any) => new Promise<Response>((resolve, reject) => requests.push({ path, options, resolve, reject }));
  const history = { pushState() {} };
  const context: any = {
    indexedDB, fetch, Response, WebSocket: FakeSocket, location: { origin: 'https://example.test', host: 'example.test', hash: '' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { getElementById: node, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll() { return []; } },
    window: { history, addEventListener() {} }, navigator: { platform: 'test' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
  };
  runInNewContext(code, context);
  const app = context.app;
  Object.assign(app.state, { token: 'test-token', connected: true, session: { sessionId: 'a' }, view: 'chat' });
  return { app, node, requests, store, sockets, draftWrites };
}

describe('PWA independent review: real-function races', () => {
  it('retains an offline-send fence across the unsolicited hello and the actual replay response', async () => {
    const x = fixture(); x.app.state.connected = false; x.app.state.epoch = 'e';
    x.node('input').value = '新请求'; const send = x.app.send();
    x.app.connect(); const socket = x.sockets[0]; socket.open();
    expect(socket.sent).toEqual([{ type: 'hello', since: 0, epoch: 'e' }]);
    // Real bridge order: upgrade's unsolicited hello, then the response to
    // the client hello, then replay frames through its advertised high-water.
    socket.receive({ kind: 'hello', seq: 2, data: { server: { epoch: 'e' }, replay: 0, gap: false } });
    socket.receive({ kind: 'hello', seq: 2, data: { server: { epoch: 'e' }, replay: 2, gap: false } });
    socket.receive({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'reasoning', reasoningChars: 8 } });
    expect(x.app.state.taskStage).not.toBe('reasoning');
    socket.receive({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2 });
    expect(x.app.state.running).toBe(true);
    expect(x.app.state.seq).toBe(2);
    x.requests[0].resolve(ack()); await send;
  });

  it('fences a send between the initial hello and the replay response', async () => {
    const x = fixture(); x.app.state.epoch = 'e'; x.app.connect();
    const socket = x.sockets[0]; socket.open();
    socket.receive({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 0, gap: false } });
    x.node('input').value = '新请求'; const send = x.app.send();
    socket.receive({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 1, gap: false } });
    socket.receive({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 1 });
    expect(x.app.state.running).toBe(true);
    x.requests[0].resolve(ack()); await send;
  });

  it('re-arms the initial-hello barrier if the socket drops before its replay response', async () => {
    const x = fixture(); x.app.state.connected = false; x.app.state.epoch = 'e';
    x.node('input').value = '新请求'; const send = x.app.send();
    x.app.connect(); const first = x.sockets[0]; first.open();
    first.receive({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 0 } });
    first.close(); x.app.connect(); const second = x.sockets[1]; second.open();
    second.receive({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 0 } });
    second.receive({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 1 } });
    second.receive({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 1 });
    expect(x.app.state.running).toBe(true);
    x.requests[0].resolve(ack()); await send;
  });

  it('accepts live events after the client hello response confirms an empty replay', async () => {
    const x = fixture(); x.app.state.connected = false; x.app.state.epoch = 'e';
    x.node('input').value = '新请求'; const send = x.app.send();
    x.app.connect(); const socket = x.sockets[0]; socket.open();
    socket.receive({ kind: 'hello', seq: 0, data: { server: { epoch: 'e' }, replay: 0, gap: false } });
    socket.receive({ kind: 'hello', seq: 0, data: { server: { epoch: 'e' }, replay: 0, gap: false } });
    socket.receive({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'output', textChars: 4 } });
    expect(x.app.state.taskStage).toBe('output');
    x.requests[0].resolve(ack()); await send;
  });

  it('shows a completed pre-ACK snapshot even if the post-ACK refresh fails', async () => {
    const x = fixture();
    x.node('input').value = '快速任务';
    const send = x.app.send();
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/start', seq: 1 });
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2 });
    x.requests[1].resolve(json([{ event: { type: 'user/message', data: { text: '快速任务' } } }, { event: { type: 'assistant/message', data: { text: '完整回复' } } }, { event: { type: 'turn/end' } }]));
    await tick();
    x.requests[0].resolve(ack());
    await send;
    x.requests[2].resolve(new Response('', { status: 502 }));
    await tick();
    expect(x.node('view').innerHTML).toContain('完整回复');
  });

  it('allows B cancellation while a prompt to A is pending', async () => {
    const x = fixture(); x.node('input').value = 'A';
    const a = x.app.send();
    const b = x.app.openSession('b'); x.requests[1].resolve(running()); await b;
    expect(x.node('stop').disabled).toBe(false);
    const cancel = x.app.cancelTurn();
    expect(x.requests[2]?.path).toBe('/mobile/sessions/b/cancel');
    x.requests[2].resolve(ack()); await cancel;
    x.requests[0].resolve(ack()); await a;
  });

  it('allows B to submit independently while A is pending and keeps B locked until B acknowledges', async () => {
    const x = fixture(); x.node('input').value = 'A';
    const a = x.app.send();
    const b = x.app.openSession('b'); x.requests[1].resolve(ended()); await b;
    x.node('input').value = 'B'; const bSend = x.app.send();
    expect(x.requests[2]?.path).toBe('/mobile/sessions/b/prompt');
    x.requests[0].resolve(ack()); await a;
    expect(x.node('stop').disabled).toBe(true);
    x.requests[2].resolve(ack()); await bSend;
  });

  it('renders the chat when reopening A while its submission is pending', async () => {
    const x = fixture(); x.node('input').value = 'A';
    const a = x.app.send();
    x.node('back').onclick();
    x.requests[1].resolve(json([{ sessionId: 'a' }])); await tick();
    expect(x.node('composer').hidden).toBe(true);
    const reopened = x.app.openSession('a');
    const req = x.requests.find((r: Request) => r.path.includes('/a/history'))!;
    req.resolve(ended()); await reopened;
    expect(x.node('composer').hidden).toBe(false);
    expect(x.node('title').textContent).not.toBe('会话');
    expect(x.node('view').innerHTML).toContain('A');
    x.requests[0].resolve(ack()); await a;
  });

  it('shows waiting after ACK when A was reopened during its submission', async () => {
    const x = fixture(); x.node('input').value = 'A'; const send = x.app.send();
    x.node('back').onclick(); x.requests[1].resolve(json([{ sessionId: 'a' }])); await tick();
    const reopened = x.app.openSession('a'); x.requests[2].resolve(ended()); await reopened;
    x.requests[0].resolve(ack()); await send;
    expect(x.app.state.taskStage).toBe('waiting');
  });

  it('does not attribute replayed previous-turn progress or end to a new offline submission', async () => {
    const x = fixture(); x.app.state.connected = false; x.node('input').value = '新请求';
    const send = x.app.send();
    x.app.applyEvent({ kind: 'hello', seq: 2, data: { server: { epoch: 'e' }, replay: 2 } });
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'reasoning', reasoningChars: 8 } });
    expect(x.app.state.taskStage).not.toBe('reasoning');
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2 });
    expect(x.app.state.running).toBe(true);
    x.requests[0].resolve(ack()); await send;
  });

  it('quarantines replay still in flight when submission occurs after hello', async () => {
    const x = fixture();
    x.app.applyEvent({ kind: 'hello', seq: 2, data: { server: { epoch: 'e' }, replay: 2 } });
    x.node('input').value = '新请求'; const send = x.app.send();
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'assistant/progress', seq: 1, data: { phase: 'output', textChars: 5 } });
    expect(x.app.state.taskStage).not.toBe('output');
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 2 });
    expect(x.app.state.running).toBe(true);
    x.requests[0].resolve(ack()); await send;
  });

  it('does not let a replayed previous turn/end end a new offline submission', async () => {
    const x = fixture(); x.app.state.connected = false; x.node('input').value = '新请求';
    const send = x.app.send();
    x.app.applyEvent({ kind: 'hello', seq: 1, data: { server: { epoch: 'e' }, replay: 1 } });
    x.app.applyEvent({ kind: 'event', sessionId: 'a', type: 'turn/end', seq: 1 });
    expect(x.app.state.running).toBe(true);
    x.requests[0].resolve(ack()); await send;
  });

  it('does not apply history started during submission after ACK', async () => {
    const x = fixture(); x.node('input').value = '新消息'; const send = x.app.send();
    const old = x.app.loadHistory('a');
    x.requests[0].resolve(ack()); await send;
    x.requests[1].resolve(ended()); await old;
    expect(x.app.state.running).toBe(true);
    expect(x.node('view').innerHTML).toContain('新消息');
    expect(x.requests.some((r: Request, i: number) => i > 1 && r.path.includes('/a/history'))).toBe(true);
  });

  it('keeps an acknowledged optimistic message when the first post-ACK snapshot has not caught up', async () => {
    const x = fixture(); x.node('input').value = '尚未入历史的新消息'; const send = x.app.send();
    x.requests[0].resolve(ack()); await send;
    x.requests[1].resolve(ended()); await tick();
    expect(x.node('view').innerHTML).toContain('尚未入历史的新消息');
    expect(x.app.state.running).toBe(true);
  });

  it('does not infer completion from a turn/end preceding the acknowledged user message', async () => {
    const x = fixture(); x.node('input').value = '新一轮消息'; const send = x.app.send();
    x.requests[0].resolve(ack()); await send;
    x.requests[1].resolve(json([{ event: { type: 'turn/end' } }, { event: { type: 'user/message', data: { text: '新一轮消息' } } }])); await tick();
    expect(x.app.state.running).toBe(true);
  });

  it('keeps waiting across repeated history snapshots until a new turn boundary arrives', async () => {
    const x = fixture(); x.node('input').value = '持续等待消息'; const send = x.app.send();
    x.requests[0].resolve(ack()); await send;
    const stale = () => json([{ event: { type: 'turn/end' } }, { event: { type: 'user/message', data: { text: '持续等待消息' } } }]);
    x.requests[1].resolve(stale()); await tick();
    const again = x.app.loadHistory('a'); x.requests[2].resolve(stale()); await again;
    expect(x.app.state.running).toBe(true);
  });

  it('keeps drafts isolated when A fails while B has unsent text', async () => {
    const x = fixture(); x.node('input').value = 'A失败草稿'; const a = x.app.send();
    const b = x.app.openSession('b'); x.requests[1].resolve(ended()); await b;
    x.node('input').value = 'B自己的草稿'; x.node('input').oninput();
    x.requests[0].resolve(new Response('', { status: 502 })); await a;
    const again = x.app.openSession('a');
    expect(x.node('input').value).toBe('A失败草稿');
    x.requests[2].resolve(ended()); await again;
    const back = x.app.openSession('b');
    expect(x.node('input').value).toBe('B自己的草稿');
    x.requests[3].resolve(ended()); await back;
  });

  it('persists the failed session draft on a real 401 before a reload', async () => {
    const x = fixture(); x.node('input').value = '需要持久化的草稿';
    const send = x.app.send(); x.requests[0].resolve(new Response('', { status: 401 })); await send;
    const reload = fixture(x.store); await reload.app.initialize();
    reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('需要持久化的草稿');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('persists edits to a recovered draft across another reload', async () => {
    const x = fixture(); x.node('input').value = '旧草稿'; const first = x.app.send();
    x.requests[0].resolve(new Response('', { status: 401 })); await first;
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a'); reload.requests[0].resolve(ended()); await opened;
    reload.node('input').value = '修改后的草稿'; reload.node('input').oninput(); await tick();
    const again = fixture(x.store); await again.app.initialize(); again.app.state.token = 'new-token';
    const reopened = again.app.openSession('a');
    expect(again.node('input').value).toBe('修改后的草稿');
    again.requests[0].resolve(ended()); await reopened;
  });

  it('removes a recovered durable draft after its resend is acknowledged', async () => {
    const x = fixture(); x.node('input').value = '恢复后要发送'; const first = x.app.send();
    x.requests[0].resolve(new Response('', { status: 401 })); await first;
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a'); reload.requests[0].resolve(ended()); await opened;
    const resend = reload.app.send(); reload.requests[1].resolve(ack()); await resend;
    const again = fixture(x.store); await again.app.initialize(); again.app.state.token = 'new-token';
    const reopened = again.app.openSession('a');
    expect(again.node('input').value).toBe('');
    again.requests[0].resolve(ended()); await reopened;
  });

  it('retains unsent text after concurrent 401s and a late ACK, including on reload', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '尚未发送'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    const third = x.app.api('/mobile/other').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 }));
    x.requests[2].resolve(new Response('', { status: 401 }));
    await Promise.all([other, third]);
    expect(x.store.get('drafts')?.a).toBe('已提交\n\n尚未发送');
    x.requests[0].resolve(ack()); await send;
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('尚未发送');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('keeps per-session recovery isolated when A ACKs and B fails after a 401', async () => {
    const x = fixture(); x.node('input').value = 'A已提交'; const a = x.app.send();
    const openedB = x.app.openSession('b'); x.requests[1].resolve(ended()); await openedB;
    x.node('input').value = 'B未确认'; const b = x.app.send();
    x.node('input').value = 'B未发送'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[3].resolve(new Response('', { status: 401 })); await other;
    x.requests[0].resolve(ack()); await a;
    x.requests[2].resolve(new Response('', { status: 502 })); await b;
    expect(x.store.get('drafts')?.a).toBeUndefined();
    expect(x.store.get('drafts')?.b).toBe('B未确认\n\nB未发送');
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const reopened = reload.app.openSession('b');
    expect(reload.node('input').value).toBe('B未确认\n\nB未发送');
    reload.requests[0].resolve(ended()); await reopened;
  });

  it('does not duplicate a pending submission across a second 401 after re-pairing', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '未发送'; x.node('input').oninput();
    const trigger = x.app.api('/mobile/trigger').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await trigger;
    await pairAgain(x, 2);
    const expiredAgain = x.app.api('/mobile/second').catch(() => {});
    x.requests[6].resolve(new Response('', { status: 401 })); await expiredAgain;
    expect(x.store.get('drafts')?.a).toBe('已提交\n\n未发送');
    x.requests[0].resolve(ack()); await send;
    expect(x.store.get('drafts')?.a).toBe('未发送');
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('未发送');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('preserves an edit during a second 401 write without duplicating it in recovery', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '未发送'; x.node('input').oninput();
    const trigger = x.app.api('/mobile/trigger').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await trigger;
    await pairAgain(x, 2);
    let release!: () => void; let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = x.app.idb.set;
    x.app.idb.set = async (key: string, value: any) => {
      if (key === 'drafts' && !started) { started = true; await gate; }
      return original(key, value);
    };
    const expiredAgain = x.app.api('/mobile/second').catch(() => {});
    x.requests[6].resolve(new Response('', { status: 401 }));
    for (let i = 0; i < 20 && !started; i++) await tick();
    expect(started).toBe(true);
    x.node('input').value = '已提交\n\n未发送（新编辑）'; x.node('input').oninput();
    x.requests[0].resolve(ack()); await tick(); release();
    await Promise.all([send, expiredAgain]);
    x.app.state.token = 'replacement-token';
    const opened = x.app.openSession('a');
    expect(x.node('input').value).toBe('已提交\n\n未发送（新编辑）');
    x.requests[7].resolve(ended()); await opened;
    expect(x.store.get('drafts')?.a).toBe('已提交\n\n未发送（新编辑）');
  });

  it('ignores a stale 401 from the old token after actual re-pairing', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '未发送'; x.node('input').oninput();
    const trigger = x.app.api('/mobile/trigger').catch(() => {});
    const stale = x.app.api('/mobile/stale').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await trigger;
    await pairAgain(x, 3);
    x.requests[2].resolve(new Response('', { status: 401 })); await stale;
    expect(x.app.state.token).toBe('replacement-token');
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('未发送');
    expect(x.store.get('drafts')?.a).toBe('未发送');
  });

  it('retains the entire edited recovery after re-pairing even when the submitted text still looks like a prefix', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '尚未发送'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    expect(x.node('input').value).toBe('已提交\n\n尚未发送');
    x.node('input').value = '已提交\n\n尚未发送（编辑）'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('已提交\n\n尚未发送（编辑）');
    const reload = fixture(x.store); const initialization = reload.app.initialize();
    await respondAt(reload, 0, ok({ device: { id: 'test' }, server: {} }));
    await respondAt(reload, 1, json([{ sessionId: 'a' }])); await initialization;
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('已提交\n\n尚未发送（编辑）');
    reload.requests[2].resolve(ended()); await opened;
  });

  it('preserves duplicate-prefix unsent draft after editing recovered content and receiving a late ACK', async () => {
    const x = fixture(); x.node('input').value = 'same'; const send = x.app.send();
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    expect(x.node('input').value).toBe('same\n\nsame\n\nextra');
    // Delete the submitted first copy, leaving the original unsent draft.
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(ack()); await send;
    console.log('duplicate-prefix late ACK input/store:', JSON.stringify({ input: x.node('input').value, stored: x.store.get('drafts')?.a }));
    expect(x.node('input').value).toBe('same\n\nextra');
    expect(x.store.get('drafts')?.a).toBe('same\n\nextra');
    const reload = fixture(x.store); const initialized = reload.app.initialize();
    await respondAt(reload, 0, ok({ device: { id: 'test' }, server: {} }));
    await respondAt(reload, 1, json([{ sessionId: 'a' }])); await initialized;
    const reopened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('same\n\nextra');
    reload.requests[2].resolve(ended()); await reopened;
  });

  it('does not strip a recovery edited and then restored to exactly the original snapshot', async () => {
    const x = fixture(); x.node('input').value = 'same'; const send = x.app.send();
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
    x.node('input').value = 'same\n\nsame\n\nextra'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('same\n\nsame\n\nextra');
    expect(x.store.get('drafts')?.a).toBe('same\n\nsame\n\nextra');
  });

  it('uses the recorded source to remove only the added copy from an unedited duplicate-prefix recovery', async () => {
    const x = fixture(); x.node('input').value = 'same'; const send = x.app.send();
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    expect(x.node('input').value).toBe('same\n\nsame\n\nextra');
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('same\n\nextra');
    expect(x.store.get('drafts')?.a).toBe('same\n\nextra');
  });

  it.each([['ACK', ack()], ['failure', new Response('', { status: 502 })]])(
    'keeps the edited duplicate-prefix draft through a second 401 and late %s', async (_kind, response) => {
      const x = fixture(); x.node('input').value = 'same'; const send = x.app.send();
      x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
      const first = x.app.api('/mobile/first').catch(() => {});
      x.requests[1].resolve(new Response('', { status: 401 })); await first;
      await pairAgain(x, 2);
      x.node('input').value = 'same\n\nextra'; x.node('input').oninput(); await tick();
      const second = x.app.api('/mobile/second').catch(() => {});
      x.requests[6].resolve(new Response('', { status: 401 })); await second;
      expect(x.store.get('drafts')?.a).toBe('same\n\nextra');
      x.requests[0].resolve(response); await send;
      expect(x.store.get('drafts')?.a).toBe('same\n\nextra');
      await pairAgain(x, 7);
      expect(x.node('input').value).toBe('same\n\nextra');
    },
  );

  it('keeps an edited recovery for A after switching to a separate B draft and receiving A ACK', async () => {
    const x = fixture(); x.node('input').value = 'same'; const send = x.app.send();
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    x.node('input').value = 'same\n\nextra'; x.node('input').oninput(); await tick();
    const b = x.app.openSession('b'); x.requests[6].resolve(ended()); await b;
    x.node('input').value = 'B draft'; x.node('input').oninput();
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('B draft');
    expect(x.store.get('drafts')?.a).toBe('same\n\nextra');
    const back = x.app.openSession('a');
    expect(x.node('input').value).toBe('same\n\nextra');
    x.requests[7].resolve(ended()); await back;
  });

  it('keeps newly typed unsent text even when it equals the acknowledged submission', async () => {
    const x = fixture(); x.node('input').value = '相同文字'; const send = x.app.send();
    x.node('input').value = '相同文字'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    expect(x.node('input').value).toBe('相同文字\n\n相同文字');
    // The user removes the submitted copy, leaving the separate unsent copy.
    x.node('input').value = '相同文字'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('相同文字');
    expect(x.store.get('drafts')?.a).toBe('相同文字');
  });

  it('keeps a re-paired edit whose confirmed prefix was itself changed', async () => {
    const x = fixture(); x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '尚未发送'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    x.node('input').value = '已提交但我修改过\n\n尚未发送'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('已提交但我修改过\n\n尚未发送');
    expect(x.store.get('drafts')?.a).toBe('已提交但我修改过\n\n尚未发送');
  });

  it('preserves a recovered and edited submission when the old request fails after re-pairing', async () => {
    const x = fixture(); x.node('input').value = '未确认'; const send = x.app.send();
    x.node('input').value = '其他草稿'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    await pairAgain(x, 2);
    x.node('input').value = '未确认\n\n其他草稿（编辑）'; x.node('input').oninput(); await tick();
    x.requests[0].resolve(new Response('', { status: 502 })); await send;
    const reload = fixture(x.store); const initialization = reload.app.initialize();
    await respondAt(reload, 0, ok({ device: { id: 'test' }, server: {} }));
    await respondAt(reload, 1, json([{ sessionId: 'a' }])); await initialization;
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('未确认\n\n其他草稿（编辑）');
    reload.requests[2].resolve(ended()); await opened;
  });

  it('serializes recovery and late ACK writes without losing the unsent text', async () => {
    const x = fixture(new Map(), { deferDraftWrites: true });
    x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '尚未发送'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 }));
    for (let i = 0; i < 20 && !x.draftWrites[0]; i++) await tick();
    expect(x.draftWrites[0]?.value.a).toBe('已提交\n\n尚未发送');
    x.requests[0].resolve(ack()); await tick();
    expect(x.draftWrites).toHaveLength(1); // ACK write waits for the first transaction.
    x.draftWrites[0].commit();
    for (let i = 0; i < 20 && !x.draftWrites[1]; i++) await tick();
    expect(x.draftWrites[1]?.value.a).toBe('尚未发送');
    x.draftWrites[1].commit(); await Promise.all([send, other]);
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('尚未发送');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('preserves edits made while the 401 recovery transaction is still in flight', async () => {
    const x = fixture(new Map(), { deferDraftWrites: true });
    x.node('input').value = '已提交'; const send = x.app.send();
    x.node('input').value = '原草稿'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 }));
    for (let i = 0; i < 20 && !x.draftWrites[0]; i++) await tick();
    expect(x.draftWrites[0]?.value.a).toBe('已提交\n\n原草稿');
    x.node('input').value = '更新后的草稿'; x.node('input').oninput();
    x.requests[0].resolve(ack()); await tick();
    expect(x.draftWrites).toHaveLength(1);
    x.draftWrites[0].commit();
    for (let n = 1; n <= 2; n++) {
      for (let i = 0; i < 20 && !x.draftWrites[n]; i++) await tick();
      expect(x.draftWrites[n]).toBeDefined();
      x.draftWrites[n].commit();
    }
    await Promise.all([send, other]);
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('更新后的草稿');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('keeps both the unconfirmed submission and edits made during a pending 401 write when sending fails', async () => {
    const x = fixture(new Map(), { deferDraftWrites: true });
    x.node('input').value = '未确认'; const send = x.app.send();
    x.node('input').value = '原草稿'; x.node('input').oninput();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 }));
    for (let i = 0; i < 20 && !x.draftWrites[0]; i++) await tick();
    expect(x.draftWrites[0]?.value.a).toBe('未确认\n\n原草稿');
    x.node('input').value = '更新后的草稿'; x.node('input').oninput();
    x.requests[0].resolve(new Response('', { status: 502 })); await send;
    x.draftWrites[0].commit();
    for (let i = 0; i < 20 && !x.draftWrites[1]; i++) await tick();
    expect(x.draftWrites[1]?.value.a).toBe('未确认\n\n更新后的草稿');
    x.draftWrites[1].commit(); await other;
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('未确认\n\n更新后的草稿');
    reload.requests[0].resolve(ended()); await opened;
  });

  it.each(['before edits', 'between edits'])(
    'retains the unconfirmed submission when failure arrives %s during pending recovery and the old composer changes', async (order) => {
      const x = fixture(new Map(), { deferDraftWrites: true });
      x.node('input').value = 'unconfirmed-submission'; const send = x.app.send();
      x.node('input').value = 'unsent-before'; x.node('input').oninput();
      const other = x.app.api('/mobile/trigger').catch(() => {});
      const concurrent = x.app.api('/mobile/concurrent').catch(() => {});
      x.requests[1].resolve(new Response('', { status: 401 }));
      x.requests[2].resolve(new Response('', { status: 401 }));
      for (let i = 0; i < 100 && !x.draftWrites[0]; i++) await tick();
      expect(x.draftWrites[0]?.value.a).toBe('unconfirmed-submission\n\nunsent-before');
      if (order === 'before edits') { x.requests[0].resolve(new Response('', { status: 502 })); await send; }
      x.node('input').value = 'unsent-intermediate'; x.node('input').oninput();
      if (order === 'between edits') { x.requests[0].resolve(new Response('', { status: 502 })); await send; }
      x.node('input').value = 'unsent-after'; x.node('input').oninput();
      expect(x.app.state.view).toBe('chat'); // recovery transaction still holds the old composer open
      x.draftWrites[0].commit();
      for (let n = 1; n <= 2; n++) {
        for (let i = 0; i < 100 && !x.draftWrites[n]; i++) await tick();
        expect(x.draftWrites[n]?.value.a).toBe('unconfirmed-submission\n\nunsent-after');
        x.draftWrites[n].commit();
      }
      await Promise.all([other, concurrent, x.app.state.durableWrites]);
      expect(x.store.get('drafts')?.a).toBe('unconfirmed-submission\n\nunsent-after');
      const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
      const opened = reload.app.openSession('a');
      expect(reload.node('input').value).toBe('unconfirmed-submission\n\nunsent-after');
      reload.requests[0].resolve(ended()); await opened;
    },
  );

  it.each(['unsent-before', ''])(
    'keeps only the separate unsent edit when ACK precedes that edit while recovery is pending (prior=%j)', async (prior) => {
    const x = fixture(new Map(), { deferDraftWrites: true });
    x.node('input').value = 'confirmed-submission'; const send = x.app.send();
    x.node('input').value = prior; x.node('input').oninput();
    const other = x.app.api('/mobile/trigger').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 }));
    for (let i = 0; i < 100 && !x.draftWrites[0]; i++) await tick();
    expect(x.draftWrites[0]?.value.a).toBe(['confirmed-submission', prior].filter(Boolean).join('\n\n'));
    x.requests[0].resolve(ack()); await tick();
    x.node('input').value = 'unsent-after'; x.node('input').oninput();
    x.draftWrites[0].commit();
    for (let n = 1; n <= 2; n++) {
      for (let i = 0; i < 100 && !x.draftWrites[n]; i++) await tick();
      expect(x.draftWrites[n]?.value.a).toBe('unsent-after');
      x.draftWrites[n].commit();
    }
    await Promise.all([send, other, x.app.state.durableWrites]);
    expect(x.store.get('drafts')?.a).toBe('unsent-after');
    const reload = fixture(x.store); await reload.app.initialize(); reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('unsent-after');
    reload.requests[0].resolve(ended()); await opened;
  });

  it('does not restore an in-flight message that subsequently receives ACK after another request gets 401', async () => {
    const x = fixture(); x.node('input').value = '其实已确认'; const send = x.app.send();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[1].resolve(new Response('', { status: 401 })); await other;
    x.requests[0].resolve(ack()); await send;
    x.app.state.token = 'new-token';
    const opened = x.app.openSession('a');
    expect(x.node('input').value).toBe('');
    x.requests[2].resolve(ended()); await opened;
  });

  it('does not duplicate draft recovery when two concurrent requests return 401', async () => {
    const x = fixture(); x.node('input').value = '只保存一次'; const send = x.app.send();
    const other = x.app.api('/mobile/test').catch(() => {});
    x.requests[0].resolve(new Response('', { status: 401 }));
    x.requests[1].resolve(new Response('', { status: 401 }));
    await Promise.all([send, other]);
    expect(x.store.get('drafts')?.a).toBe('只保存一次');
  });

  it('does not turn an acknowledged resend into an apparent send failure when draft storage fails', async () => {
    const x = fixture(); x.app.state.durableDrafts = { a: '恢复的消息' }; x.node('input').value = '恢复的消息';
    x.app.idb.set = async () => { throw new Error('disk error'); };
    const send = x.app.send(); x.requests[0].resolve(ack()); await send;
    expect(x.node('input').value).toBe('');
    expect(x.node('toast').textContent).not.toContain('发送未确认');
  });

  it('makes an unsaved recovery draft copyable on pairing if IndexedDB storage fails', async () => {
    const x = fixture(); x.node('input').value = '请复制 <草稿>';
    x.app.idb.set = async () => false;
    const send = x.app.send(); x.requests[0].resolve(new Response('', { status: 401 })); await send;
    expect(x.node('view').innerHTML).toContain('请复制 &lt;草稿&gt;');
    expect(x.node('view').innerHTML).toContain('textarea');
  });

  it('finishes 401 recovery on an IndexedDB delete transaction error', async () => {
    const x = fixture(new Map(), { deleteFails: true }); x.node('input').value = '交易失败的草稿';
    const send = x.app.send(); x.requests[0].resolve(new Response('', { status: 401 }));
    const finished = await Promise.race([send.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30))]);
    expect(finished).toBe(true);
    expect(x.node('title').textContent).toBe('配对这台手机');
    expect(x.node('view').innerHTML).toContain('旧令牌未能从本机存储删除');
  });

  it('still shows pairing and preserves the draft if token deletion throws during 401 handling', async () => {
    const x = fixture(); x.node('input').value = '令牌存储错误时的草稿';
    x.app.idb.del = async () => { throw new Error('disk error'); };
    const send = x.app.send(); x.requests[0].resolve(new Response('', { status: 401 })); await send;
    expect(x.node('title').textContent).toBe('配对这台手机');
    expect(x.store.get('drafts')?.a).toBe('令牌存储错误时的草稿');
  });

  it('on 401 actually forgets the token, renders pairing and restores the durable session draft after reload', async () => {
    const x = fixture(); x.store.set('token', 'test-token'); x.store.set('device', { id: 'test' });
    x.node('input').value = '需要重新配对的草稿'; const send = x.app.send();
    x.requests[0].resolve(new Response('', { status: 401 })); await send;
    expect(x.store.has('token')).toBe(false);
    expect(x.node('title').textContent).toBe('配对这台手机');
    const reload = fixture(x.store);
    await reload.app.initialize();
    reload.app.state.token = 'new-token';
    const opened = reload.app.openSession('a');
    expect(reload.node('input').value).toBe('需要重新配对的草稿');
    reload.requests[0].resolve(ended()); await opened;
  });
});
