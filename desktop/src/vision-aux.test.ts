import { afterEach, describe, expect, it, vi } from "vitest";
import { apply, modelSeesImages, rewriteMessageImages } from "../resources/plugins/vision-aux/src/index";
import type { VisionAuxOptions } from "../resources/plugins/vision-aux/src/vision";

interface ImageRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number
  height: number
}

function imageBlock(id: string, width = 100, height = 50) {
  return { type: "image", attachment: { attachmentId: id, mediaType: "image/png", bytes: 3, width, height } };
}

function message(id: string, blocks: Array<Record<string, unknown>>) {
  return { id, role: "user", content: blocks, source: { kind: "user" } } as never;
}

const options: VisionAuxOptions = {
  baseURL: "https://vision.test/v1",
  apiKey: "sk-test",
  model: "qwen-vl-max",
  prompt: "describe",
  timeoutMs: 5_000,
};

function visionResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: text } }] }),
  } as unknown as Response;
}

describe("modelSeesImages", () => {
  it("follows the resolved input modalities", async () => {
    const agent = { options: { provider: "deepseek", model: "deepseek-chat" } };
    const llm = { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
    expect(await modelSeesImages(llm as never, agent as never, new Map(), false)).toBe(false);
    const visionLlm = { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) };
    expect(await modelSeesImages(visionLlm as never, agent as never, new Map(), false)).toBe(true);
  });

  it("caches per provider/model and honours skipWhenUnknown for missing metadata", async () => {
    const agent = { options: { provider: "p", model: "m" } };
    const calls: string[] = [];
    const llm = {
      resolveModelInfo: async () => {
        calls.push("called");
        return {};
      },
    };
    const cache = new Map<string, boolean>();
    expect(await modelSeesImages(llm as never, agent as never, cache, true)).toBe(true);
    expect(await modelSeesImages(llm as never, agent as never, cache, false)).toBe(true); // cached
    expect(calls).toHaveLength(1);
    expect(await modelSeesImages(llm as never, { options: {} } as never, new Map(), false)).toBe(false);
  });
});

describe("rewriteMessageImages", () => {
  it("replaces image blocks with descriptions and preserves identity", async () => {
    const read: string[] = [];
    const attachments = {
      readImage: async (ref: ImageRef) => {
        read.push(ref.attachmentId);
        return { data: new Uint8Array([1, 2, 3]), mediaType: ref.mediaType };
      },
    };
    const fetchMock = vi.fn(async () => visionResponse("一张截图，内容是报错"));
    const next = await rewriteMessageImages(
      attachments as never,
      message("m1", [{ type: "text", text: "看图" }, imageBlock("a1"), imageBlock("a2", 640, 480)]) as never,
      { ...options, fetchImpl: fetchMock as unknown as typeof fetch },
    );
    const content = (next as unknown as { content: Array<{ type: string; text?: string }> }).content;
    expect(read).toEqual(["a1", "a2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(content[0]).toEqual({ type: "text", text: "看图" });
    expect(content[1]?.text).toContain("[图片 1/2，100×50 像素，由视觉辅助模型 qwen-vl-max 识别]");
    expect(content[1]?.text).toContain("一张截图，内容是报错");
    expect(content[2]?.text).toContain("[图片 2/2，640×480 像素");
    expect((next as unknown as { id: string }).id).toBe("m1");
  });

  it("degrades to a placeholder when the vision call fails", async () => {
    const attachments = {
      readImage: async () => ({ data: new Uint8Array([1]), mediaType: "image/png" }),
    };
    const next = await rewriteMessageImages(
      attachments as never,
      message("m2", [imageBlock("bad")]) as never,
      {
        ...options,
        fetchImpl: (async () => ({ ok: false, status: 401, text: async () => "unauthorized" })) as unknown as typeof fetch,
      },
    );
    const text = (next as unknown as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
    expect(text).toContain("视觉辅助模型调用失败");
    expect(text).toContain("401");
  });
});

describe("vision-aux apply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureListener() {
    const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>();
    const ctx = {
      on: (name: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        listeners.set(name, listener);
      },
      llm: { resolveModelInfo: async () => ({ inputModalities: ["text"] }) },
      attachments: {
        readImage: async () => ({ data: new Uint8Array([9]), mediaType: "image/png" }),
      },
    };
    return { ctx: ctx as never, listeners };
  }

  it("rewrites images for a text-only model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => visionResponse("描述文本")));
    const { ctx, listeners } = captureListener();
    apply(ctx, { baseURL: "https://v.test/v1", model: "vl", apiKey: "k" });
    const listener = listeners.get("agent/pre-step");
    expect(listener).toBeDefined();
    const decision = (await listener?.(
      { agent: { options: { provider: "deepseek", model: "deepseek-chat" } }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: "enter", messages: [message("m", [imageBlock("i")])] }),
    )) as { kind: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(decision.kind).toBe("enter");
    expect(decision.messages[0]?.content[0]?.type).toBe("text");
    expect(decision.messages[0]?.content[0]?.text).toContain("描述文本");
  });

  it("passes images through when the selected model sees images", async () => {
    const { ctx, listeners } = captureListener();
    ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) } as never;
    apply(ctx, { baseURL: "https://v.test/v1", model: "vl", apiKey: "k" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const original = message("m", [imageBlock("i")]);
    const decision = (await listeners.get("agent/pre-step")?.(
      { agent: { options: { provider: "deepseek", model: "deepseek-vl" } }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: "enter", messages: [original] }),
    )) as { kind: string; messages: unknown[] };
    expect(decision.messages[0]).toBe(original);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing without a configured vision model", async () => {
    const { ctx, listeners } = captureListener();
    apply(ctx, {});
    const original = message("m", [imageBlock("i")]);
    const decision = (await listeners.get("agent/pre-step")?.(
      { agent: { options: { provider: "deepseek", model: "deepseek-chat" } }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: "enter", messages: [original] }),
    )) as { messages: unknown[] };
    expect(decision.messages[0]).toBe(original);
  });
});
