import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The mobile bridge's browser half. It is hand-written in the host's loader
 * format, so the test plays the loader: hand it a fake `window`, a fake React
 * and a fake ctx, then check the contract the engine relies on.
 *
 * The pairing UI moved here from the desktop shell's settings window on purpose
 * (it must render inside the engine's own settings, in the harness's design
 * language, and the plugin must stay the only writer of the pairing store), so
 * these assertions are the regression fence around that decision.
 */
async function loadClient(): Promise<{ factory: (require: (id: string) => unknown) => any; calls: string[] }> {
  const file = path.join(__dirname, "..", "resources", "plugins", "mobile-bridge", "client", "client.js");
  const source = await readFile(file, "utf8");
  let factory: ((require: (id: string) => unknown) => unknown) | null = null;
  const calls: string[] = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          calls.push(options.id);
          factory = options.factory;
        },
      },
    },
    console,
    navigator: { language: "zh-CN" },
    fetch: async () => ({ ok: true, text: async () => "{}" }),
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: file });
  if (factory === null) throw new Error("client.js never called window.__ModuleLoader__.load");
  return { factory, calls };
}

function fakeReact(): unknown {
  return {
    createElement: (type: unknown, props: unknown, children: unknown) => ({ type, props, children }),
    useState: (value: unknown) => [value, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
  };
}

describe("mobile-bridge settings client", () => {
  it("registers itself as the 「手机配对」 settings section", async () => {
    const { factory, calls } = await loadClient();
    expect(calls).toEqual(["@dsh-desktop/dsh-mobile-bridge"]);

    const pageModule = factory(fakeReact) as {
      name: string;
      inject: string[];
      apply: (ctx: unknown) => void;
      COPY: Record<string, Record<string, string>>;
    };
    expect(pageModule.name).toBe("dsh-mobile-bridge");
    expect(pageModule.inject).toEqual(["slots", "locale"]);

    const registrations: Array<Record<string, unknown>> = [];
    const seat: string[] = [];
    const ctx = {
      locale: { getSnapshot: () => ({ active: "zh-CN" }) },
      slots: {
        inject: (name: string, run: () => void) => {
          expect(name).toBe("settings.section");
          run();
        },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ ...options, component });
        },
      },
    };
    pageModule.apply(ctx);

    expect(registrations).toHaveLength(1);
    const registration = registrations[0] as Record<string, unknown>;
    expect(registration.name).toBe("settings.section");
    expect(registration.id).toBe("mobile-bridge");
    expect(typeof registration.order).toBe("number");
    expect((registration.label as () => string)()).toBe("手机配对");
    expect(typeof registration.component).toBe("function");

    // The seat ping is the server-side trace that the page actually mounted.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pageModule.COPY.zh.nav).toBe("手机配对");
    expect(pageModule.COPY.en.nav).toBe("Phone pairing");
  });

  it("talks only to the bridge's loopback routes and never fails silently", async () => {
    const file = path.join(__dirname, "..", "resources", "plugins", "mobile-bridge", "client", "client.js");
    const source = await readFile(file, "utf8");
    for (const route of [
      "/mobile-local/state",
      "/mobile-local/rotate",
      "/mobile-local/config",
      "/mobile-local/qr",
      "/mobile-local/devices/",
    ]) {
      expect(source).toContain(route);
    }
    // Every failure path must render text: the old shell card could swallow an
    // exception and show nothing at all, which is exactly what was reported.
    for (const marker of ["errState", "errRotate", "errRevoke", "errConfig", "catch (error)"]) {
      expect(source).toContain(marker);
    }
    // The QR tile must stay on white — scanners fail on a themed tile.
    expect(source).toContain('background: "#ffffff"');
  });
});
