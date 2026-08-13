import type { ChatMessage, LlmMessage, LlmToolCall } from "../types";

export interface ChatStreamDelta {
  thinking?: string;
  text?: string;
  toolCalls?: LlmToolCall[];
  finishReason?: string | null;
}

export async function* streamChat(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking: boolean;
  messages: LlmMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  localProxy?: boolean;
}): AsyncGenerator<ChatStreamDelta> {
  const target = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true,
    tools: options.tools,
    thinking: { type: options.thinking ? "enabled" : "disabled" },
  };
  if (options.thinking) body.reasoning_effort = "high";

  const response = await fetch(options.localProxy ? "/__dsh/llm" : target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.localProxy ? {} : { Authorization: `Bearer ${options.apiKey}` }),
    },
    body: JSON.stringify(
      options.localProxy
        ? { url: target, apiKey: options.apiKey, body }
        : body,
    ),
    signal: options.signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 800)}`);
  }
  if (!response.body) throw new Error("DeepSeek API returned an empty body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolAcc = new Map<number, LlmToolCall>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n");
    buffer = chunks.pop() ?? "";
    for (const line of chunks) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let json: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
      };
      try {
        json = JSON.parse(data) as typeof json;
      } catch {
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) yield { thinking: delta.reasoning_content };
      if (delta.content) yield { text: delta.content };
      if (delta.tool_calls) {
        for (const part of delta.tool_calls) {
          const index = part.index ?? 0;
          const current = toolAcc.get(index) ?? {
            id: part.id ?? `call_${index}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.function.name += part.function.name;
          if (part.function?.arguments) current.function.arguments += part.function.arguments;
          toolAcc.set(index, current);
        }
      }
      if (choice.finish_reason) {
        yield {
          finishReason: choice.finish_reason,
          toolCalls: toolAcc.size ? [...toolAcc.values()] : undefined,
        };
        toolAcc.clear();
      }
    }
  }
  if (toolAcc.size) {
    yield { finishReason: "tool_calls", toolCalls: [...toolAcc.values()] };
  }
}

export function toLlmMessages(messages: ChatMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.blocks.map((block) => block.text ?? "").join("\n").trim();
      out.push({ role: "user", content: text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const text = message.blocks
      .filter((block) => block.type === "text" || block.type === "plan")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    const tools = message.blocks.filter((block) => block.type === "tool" && block.tool);
    const toolCalls: LlmToolCall[] = tools.map((block) => ({
      id: block.tool!.id,
      type: "function",
      function: {
        name: String(block.tool!.name),
        arguments: JSON.stringify(block.tool!.args ?? {}),
      },
    }));
    if (text || toolCalls.length) {
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });
    }
    for (const block of tools) {
      out.push({
        role: "tool",
        tool_call_id: block.tool!.id,
        content: block.tool!.result,
      });
    }
  }
  return out;
}
