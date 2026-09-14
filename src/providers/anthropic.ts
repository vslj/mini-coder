/**
 * providers/anthropic.ts —— Anthropic 原生协议分支（实验通道：小米 MiMo /anthropic）。
 *
 * 与 openai.ts 实现同一个 Provider 接口，但协议处处不同——这份"差异清单"
 * 就是 provider 抽象层存在的理由（博客①的核心对照材料）：
 *
 *   | 差异点     | OpenAI 兼容                    | Anthropic 原生                          |
 *   |-----------|-------------------------------|----------------------------------------|
 *   | system     | messages 数组第一条             | 顶层参数（不进 messages）                 |
 *   | max_tokens | 可选                          | 必填（协议无默认值）                      |
 *   | 鉴权       | Authorization: Bearer          | x-api-key + anthropic-version 头         |
 *   | 思维链     | 厂商私有字段 reasoning_content  | content 数组里的 thinking 块             |
 *   | 停止原因   | stop / length                  | end_turn / max_tokens                   |
 *   | 流式       | 纯 data: 行流                  | event: + data: 成对的事件流              |
 *   | 工具说明书  | {type:"function", function:{…}}| {name, description, input_schema}        |
 *   | 工具参数    | arguments 是 **JSON 字符串**    | input 直接是 JSON 对象                   |
 *   | 工具结果    | 独立 role:"tool" 消息          | 塞进下一条 user 消息的 tool_result 块     |
 *
 * MiMo 实测方言（2026-09-11，详见 NOTES）：thinking 块在流式里先于 text、
 * 在非流式里却后于 text；message_start 里的 usage 数值不可信（input_tokens=1）；
 * anthropic-version 头不强制（官方协议要求，仍照发）。
 */

import type { AppConfig } from "../config.js";
import { ProviderError, withRetry } from "../errors.js";
import { sseLines } from "../sse.js";
import type { ChatMessage, ChatOptions, ChatResult, Provider, StopReason, ToolCall, ToolSchema } from "../types.js";

/** Anthropic 协议必填项，OpenAI 没有这个概念——放这里而不是 config，它属于协议细节。 */
const MAX_TOKENS = 4096;

function normalizeStop(stopReason: string | null | undefined): StopReason {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "tool_use") return "tool_use";
  return "other";
}

/** 工具说明书出站翻译：中立 ToolSchema → Anthropic 的 input_schema 形态。 */
function toWireTools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/**
 * 中立消息 → Anthropic 协议。这里有两处协议独有的规矩：
 *
 *  1. 工具结果不是独立消息，而是塞进"紧接着的 user 消息"的 tool_result 块里；
 *     中立格式里每条工具结果是独立消息，所以连续的 tool 消息要在这里
 *     合并成一条 user 消息（多个块）——合并逻辑是 Anthropic 分支的独门活。
 *  2. assistant 要调工具时，content 是块数组：文本块（可有可无）+ tool_use 块。
 *     thinking 块在这里消失——中立格式本来就不回传 reasoning，阶段 1 实验①
 *     证明 MiMo 端点对此照单全收（真 Anthropic 开 thinking 时会强制要求回传，
 *     到时候是 provider 内部要补的特殊处理，中立格式不用动）。
 */
function toWireMessages(messages: ChatMessage[]): object[] {
  const wire: object[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      // 前一条已经是"装工具结果的 user 消息"就往里追加，否则新开一条
      const last = wire[wire.length - 1] as { role?: string; content?: unknown } | undefined;
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as object[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.toolCalls) {
      const blocks: object[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      wire.push({ role: "assistant", content: blocks });
      continue;
    }
    wire.push({ role: m.role, content: m.content });
  }
  return wire;
}

export function createAnthropicProvider(cfg: AppConfig): Provider {
  async function fetchResponse(body: object, signal?: AbortSignal): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(`${cfg.anthropicUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.key, // OpenAI 用 Bearer，Anthropic 原生用这个头
          "anthropic-version": "2023-06-01", // MiMo 不强制，但官方协议要求，照发
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e; // 用户主动中断不是错误
      throw new ProviderError("network", `网络错误: ${e instanceof Error ? e.message : e}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new ProviderError("http", `HTTP ${resp.status}: ${text.slice(0, 300)}`, resp.status);
    }
    return resp;
  }

  return {
    name: "anthropic",

    async chat(messages, opts) {
      // system 是顶层参数，不在 messages 里；max_tokens 必填
      const body = {
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        ...(opts?.system ? { system: opts.system } : {}),
        ...(opts?.tools ? { tools: toWireTools(opts.tools) } : {}),
        messages: toWireMessages(messages),
      };
      const resp = await withRetry(() => fetchResponse(body, opts?.signal), 3, "chat");

      const data = (await resp.json()) as {
        content?: {
          type: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }[];
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!Array.isArray(data.content)) {
        throw new ProviderError("protocol", `响应缺少 content 数组: ${JSON.stringify(data).slice(0, 300)}`);
      }

      // 防御性遍历 content 数组：只认 text/thinking/tool_use 块，未知类型跳过（协议在演化）
      let content = "";
      let reasoning = "";
      const toolCalls: ToolCall[] = [];
      for (const block of data.content) {
        if (block.type === "text" && block.text) content += block.text;
        if (block.type === "thinking" && block.thinking) reasoning += block.thinking;
        // tool_use 块：input 已是对象，无需 parse（与 OpenAI 分支的对照点）
        if (block.type === "tool_use" && block.id && block.name) {
          toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
        }
      }

      const result: ChatResult = { content, stopReason: normalizeStop(data.stop_reason) };
      if (reasoning) result.reasoning = reasoning;
      if (toolCalls.length) result.toolCalls = toolCalls;
      if (data.usage?.input_tokens !== undefined && data.usage.output_tokens !== undefined) {
        result.usage = { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens };
      }
      return result;
    },

    async chatStream(messages, onEvent, opts) {
      // 阶段 1 范围：流式暂不支持 tool_use 块的 input_json_delta 累积（与 OpenAI 分支同理），
      // 工具轮次一律走非流式 chat()。流式+工具作为后续可选支线。
      const body = {
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        ...(opts?.system ? { system: opts.system } : {}),
        messages: toWireMessages(messages),
        stream: true,
      };

      // 与 openai.ts 同理：重试只保护"拿到响应体之前"，流一旦开始不能重来
      const resp = await withRetry(() => fetchResponse(body, opts?.signal), 3, "chatStream");
      if (!resp.body) throw new ProviderError("protocol", "响应没有 body，无法流式读取");

      let content = "";
      let reasoning = "";
      let stopReason: StopReason = "other";
      let usage: ChatResult["usage"];

      for await (const line of sseLines(resp.body)) {
        // Anthropic 流是 event: + data: 成对出现；data.type 自带事件名，
        // 所以 event: 行可以不解析（读它只是教学演示两种流的形态差异）
        if (line.startsWith("event:")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;

        let data: {
          type: string;
          message?: { usage?: { input_tokens?: number } };
          delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
          usage?: { output_tokens?: number };
        };
        try {
          data = JSON.parse(payload);
        } catch {
          throw new ProviderError("protocol", `流中出现无法解析的 data 行: ${payload.slice(0, 200)}`);
        }

        switch (data.type) {
          case "message_start":
            // 输入 token 在流的开头就到（OpenAI 协议没有这个能力）；
            // 但 MiMo 这里给的是 1（不可信），真实账目在 message_delta
            if (data.message?.usage?.input_tokens !== undefined) {
              usage = { inputTokens: data.message.usage.input_tokens, outputTokens: 0 };
            }
            break;
          case "content_block_delta":
            if (data.delta?.type === "text_delta" && data.delta.text) {
              content += data.delta.text;
              onEvent({ type: "text", text: data.delta.text });
            } else if (data.delta?.type === "thinking_delta" && data.delta.thinking) {
              reasoning += data.delta.thinking;
              onEvent({ type: "reasoning", text: data.delta.thinking });
            }
            // 其他 delta（signature_delta 等）跳过不炸
            break;
          case "message_delta":
            if (data.delta?.stop_reason) {
              stopReason = normalizeStop(data.delta.stop_reason);
            }
            if (data.usage?.output_tokens !== undefined) {
              usage = {
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: data.usage.output_tokens,
              };
              onEvent({ type: "usage", usage });
            }
            break;
          case "message_stop":
            onEvent({ type: "done", stopReason });
            break;
          // ping / content_block_start / content_block_stop 等一律忽略
        }
      }

      const result: ChatResult = { content, stopReason };
      if (reasoning) result.reasoning = reasoning;
      if (usage) result.usage = usage;
      return result;
    },
  };
}
