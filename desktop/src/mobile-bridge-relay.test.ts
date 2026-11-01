import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { acceptUpgrade, type WsConnection } from '../resources/plugins/mobile-bridge/src/ws';
import { startRelayLink } from '../resources/plugins/mobile-bridge/lib/relay.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function until(fn: () => boolean, timeout = 2500): Promise<void> {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() >= end) throw new Error('timed out waiting for relay message');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('mobile relay upstream websocket channel', () => {
  let relay: Server | undefined;
  let engine: Server | undefined;
  let link: ReturnType<typeof startRelayLink> | undefined;
  const sockets: WsConnection[] = [];
  afterEach(async () => {
    link?.stop();
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all([relay, engine].map((server) => server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve()));
    relay = undefined; engine = undefined; link = undefined;
  });

  it('preserves phone text frames after the bridge has opened', async () => {
    const atEngine: string[] = [];
    engine = createServer();
    engine.on('upgrade', (req, raw, head) => {
      const conn = acceptUpgrade(req, raw, head, { onMessage(_c, text) { atEngine.push(text); }, onClose() {} });
      if (conn) sockets.push(conn);
    });
    const enginePort = await listen(engine);
    const atRelay: any[] = [];
    let desktop: WsConnection | undefined;
    relay = createServer();
    relay.on('upgrade', (req, raw, head) => {
      desktop = acceptUpgrade(req, raw, head, { onMessage(_c, text) { atRelay.push(JSON.parse(text)); }, onClose() {} });
      if (desktop) sockets.push(desktop);
    });
    const relayPort = await listen(relay);
    link = startRelayLink({ candidates: [{ url: `ws://127.0.0.1:${relayPort}` }], deviceKey: 'test-device', secret: 'test-secret-not-real', localPort: enginePort });
    await until(() => !!desktop && link?.status() === 'online');
    desktop!.send(JSON.stringify({ t: 'up', id: 'text-channel', url: '/mobile/events?token=test-token' }));
    await until(() => atRelay.some((f) => f.t === 'up' && f.ok === true));
    const hello = JSON.stringify({ type: 'hello', since: 10 });
    desktop!.send(JSON.stringify({ t: 'data', id: 'text-channel', bin: false, b64: Buffer.from(hello).toString('base64') }));
    await until(() => atEngine.length === 1);
    expect(atEngine).toEqual([hello]);
  }, 10000);

  it('queues an immediate phone hello until the bridge is open and preserves text frames in both directions', async () => {
    const atEngine: string[] = [];
    engine = createServer();
    engine.on('upgrade', (req, raw, head) => {
      // Delay the bridge's upgrade to reproduce a phone sending in onOpen.
      setTimeout(() => {
        const conn = acceptUpgrade(req, raw, head, {
          onMessage(c, text) { atEngine.push(text); c.send(JSON.stringify({ kind: 'hello', data: { gap: false } })); },
          onClose() {},
        });
        if (conn) sockets.push(conn);
      }, 180);
    });
    const enginePort = await listen(engine);

    const atRelay: any[] = [];
    let desktop: WsConnection | undefined;
    relay = createServer();
    relay.on('upgrade', (req, raw, head) => {
      desktop = acceptUpgrade(req, raw, head, {
        onMessage(_c, text) { atRelay.push(JSON.parse(text)); },
        onClose() {},
      });
      if (desktop) sockets.push(desktop);
    });
    const relayPort = await listen(relay);
    link = startRelayLink({ candidates: [{ url: `ws://127.0.0.1:${relayPort}` }], deviceKey: 'test-device', secret: 'test-secret-not-real', localPort: enginePort });
    await until(() => !!desktop && link?.status() === 'online');
    desktop!.send(JSON.stringify({ t: 'up', id: 'test-channel', url: '/mobile/events?token=test-token' }));
    // The actual cloud relay returns 101 before the desktop opens its upstream.
    const hello = JSON.stringify({ type: 'hello', since: 999999 });
    desktop!.send(JSON.stringify({ t: 'data', id: 'test-channel', bin: false, b64: Buffer.from(hello).toString('base64') }));
    await until(() => atEngine.length === 1);
    expect(atEngine).toEqual([hello]);
    await until(() => atRelay.some((f) => f.t === 'data' && f.id === 'test-channel'));
    const response = atRelay.find((f) => f.t === 'data' && f.id === 'test-channel');
    expect(response.bin).toBe(false);
    expect(JSON.parse(Buffer.from(response.b64, 'base64').toString('utf8'))).toMatchObject({ kind: 'hello' });
  }, 10000);
});
