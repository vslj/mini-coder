/**
 * providers/openai.ts —— OpenAI 兼容协议分支（实验通道：小米 MiMo /v1）。
 *
 * 这是被 M1/M2/M5 全程验证过的协议：请求体 {model, messages, ...}，
 * system 是 messages 数组的第一条，鉴权用 Authorization: Bearer。
 * Anthropic 分支（anthropic.ts）与它实现同一个 Provider 接口——
 * 两个文件的对照本身就是"协议差异"这门课的教材。
 */

import type { AppConfig } from "../config.js";
import { ProviderError, withRetry } from "../errors.js";
import { sseLines } from "../sse.js";
import type { ChatMessage, ChatOptions, ChatResult, Provider, StopReason, StreamEvent, ToolSchema } from "../types.js";

/** 归一化 OpenAI 的 finish_reason；tool_calls 就是"模型想调工具"（Anthropic 叫 tool_use）。 */
function normalizeStop(finishReason: string | null | undefined): StopReason {
  if (finishReason === "stop") return "stop";
  if (finishReason === "length") return "length";
  if (finishReason === "tool_calls") return "tool_use";
  return "other";
}

/** 工具说明书出站翻译：中立 ToolSchema → OpenAI 的 function 包装。 */
function toWireTools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** 把中立消息翻译成 OpenAI 协议的消息数组；system 独立字段落回数组首位。 */
function toWireMessages(messages: ChatMessage[], system?: string): object[] {
  const wire: object[] = [];
  if (system) wire.push({ role: "system", content: system });
  for (const m of messages) {
    // 只回传 content：reasoning 是瞬时展示字段，绝不回传下一轮（M1 实证的坑）
    if (m.role === "tool") {
      // 工具结果：OpenAI 的规矩是独立消息 + tool_call_id 对号
      wire.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
      continue;
    }
    if (m.toolCalls) {
      // 带工具调用的 assistant 消息：args（对象）在这里变回 JSON 字符串
      wire.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      continue;
    }
    wire.push({ role: m.role, content: m.content });
  }
  return wire;
}

export function createOpenAIProvider(cfg: AppConfig): Provider {
  /** 发请求并处理传输层错误：HTTP 状态 → ProviderError，网络故障 → 包装成 network。 */
  async function fetchResponse(body: object, signal?: AbortSignal): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(`${cfg.openaiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // 用户主动中断（Ctrl+C）不是错误，原样抛出让上层识别 AbortError
      if (signal?.aborted) throw e;
      // 裸 fetch 的网络错误是普通 TypeError，这里负责包装成结构化错误，
      // withRetry 的 isRetryable 才认得（M5 靠正则抓字符串的教训）
      throw new ProviderError("network", `网络错误: ${e instanceof Error ? e.message : e}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new ProviderError("http", `HTTP ${resp.status}: ${text.slice(0, 300)}`, resp.status);
    }
    return resp;
  }

  return {
    name: "openai",

    async chat(messages, opts) {
      const body = {
        model: cfg.model,
        messages: toWireMessages(messages, opts?.system),
        ...(opts?.tools ? { tools: toWireTools(opts.tools) } : {}),
      };
      const resp = await withRetry(() => fetchResponse(body, opts?.signal), 3, "chat");

      const data = (await resp.json()) as {
        choices?: {
          message?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      // noUncheckedIndexedAccess：choices[0] 可能不存在，防御性处理协议差异
      const choice = data.choices?.[0];
      if (!choice) {
        throw new ProviderError("protocol", `响应缺少 choices[0]: ${JSON.stringify(data).slice(0, 300)}`);
      }

      const result: ChatResult = {
        content: choice.message?.content ?? "",
        stopReason: normalizeStop(choice.finish_reason),
      };
      if (choice.message?.reasoning_content) result.reasoning = choice.message.reasoning_content;
      // 工具调用入站翻译：arguments（JSON 字符串）parse 成对象。
      // parse 失败不炸——模型偶尔会产出坏 JSON，降级成空参数让上层靠
      // "工具报错→模型重试"的自愈机制处理（agent 循环天生能消化这种脏数据）
      if (choice.message?.tool_calls?.length) {
        result.toolCalls = choice.message.tool_calls.map((c) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function?.arguments ?? "{}") as Record<string, unknown>;
          } catch {
            args = {};
          }
          return { id: c.id ?? "", name: c.function?.name ?? "", args };
        });
      }
      // 只信 prompt/completion 两个字段；MiMo 的 reasoning_tokens=0 怪癖（NOTES）证明细分字段不可全信
      if (data.usage?.prompt_tokens !== undefined && data.usage.completion_tokens !== undefined) {
        result.usage = { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens };
      }
      return result;
    },

    async chatStream(messages, onEvent, opts) {
      // 阶段 1 范围：流式暂不支持 tool_calls 增量（要累积 delta 再拼参数，复杂度高），
      // 工具轮次一律走非流式 chat()。流式+工具作为后续可选支线。
      // stream_options.include_usage：请求服务端在最后一个 chunk 里带上 usage
      //（MiMo 是否支持实测见 NOTES；不支持就整体缺省，类型上已允许）
      const body = {
        model: cfg.model,
        messages: toWireMessages(messages, opts?.system),
        stream: true,
        stream_options: { include_usage: true },
      };

      // 重试只保护"连不上/被限流"——fetch 失败发生在拿到响应体之前，
      // 流一旦开始消费就不能重试（会从头再来一遍，回调已经画过一半了）
      const resp = await withRetry(() => fetchResponse(body, opts?.signal), 3, "chatStream");
      if (!resp.body) throw new ProviderError("protocol", "响应没有 body，无法流式读取");

      // 边流边拼最终结果；每收到一块就交给回调
      let content = "";
      let reasoning = "";
      let stopReason: StopReason = "other";
      let usage: ChatResult["usage"];

      for await (const line of sseLines(resp.body)) {
        // OpenAI 流只有一种有效行：data: {...}。最后一条是字面量 data: [DONE]
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break; // 某些网关不发 [DONE]，流自然结束也能兜底

        // 防御协议差异：坏行不该让整个进程崩掉，报成 protocol 错（这类错不重试）
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          throw new ProviderError("protocol", `流中出现无法解析的 data 行: ${payload.slice(0, 200)}`);
        }

        const typed = chunk as {
          choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const choice = typed.choices?.[0];
        if (!choice) continue; // 纯 usage 的收尾 chunk 没有 choices，跳过即可

        const delta = choice.delta;
        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
          onEvent({ type: "reasoning", text: delta.reasoning_content });
        }
        if (delta?.content) {
          content += delta.content;
          onEvent({ type: "text", text: delta.content });
        }
        if (choice.finish_reason) {
          stopReason = normalizeStop(choice.finish_reason);
          onEvent({ type: "done", stopReason });
        }
        if (typed.usage?.prompt_tokens !== undefined && typed.usage.completion_tokens !== undefined) {
          usage = { inputTokens: typed.usage.prompt_tokens, outputTokens: typed.usage.completion_tokens };
          onEvent({ type: "usage", usage });
        }
      }

      const result: ChatResult = { content, stopReason };
      if (reasoning) result.reasoning = reasoning;
      if (usage) result.usage = usage;
      return result;
    },
  };
}
