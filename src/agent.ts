/**
 * agent.ts —— agent 主循环：mini-coder 的心脏。
 *
 * 原型是 learning/m3/agent.mjs（M3 毕业实验的 ~25 行裸循环），
 * 正式版多了三样工程化的东西：
 *
 *  1. 回合原子性：真错误（网络错等）发生时把历史回滚到回合开始前——
 *     失败的回合不留残迹。用户 Ctrl+C 例外：中断时刻的历史总是协议合法的，
 *     进度保留（见 catch 处的注释），"继续"能接得上；
 *  2. 轮数上限：不设上限的循环，模型钻牛角尖时就是无底的 token 黑洞（M5 教训）；
 *  3. 钩子（hooks）：循环通过回调报告"正在调什么工具、结果如何"，
 *     渲染留在 REPL 侧——核心循环不掺任何终端输出，教学和测试都干净。
 *
 * 循环骨架（与裸版一模一样）：
 *   想（模型决定要不要工具）→ 做（执行器真的执行）→ 看（结果回填历史）→ 再想……
 *   直到模型不再要工具（自然停）或轮数用尽（强制停）。
 *
 * 阶段 1 范围：工具轮次走非流式 chat()——流式+工具的 delta 累积是后续支线，
 * 第一版保持"每步只引入一个新概念"。
 */

import type { ChatMessage, Provider, Usage } from "./types.js";
import type { PermissionGate } from "./permissions.js";
import type { ToolRegistry } from "./tools.js";

/** 循环对外报告进度的回调；全部可选，不传就是静默循环。 */
export interface AgentHooks {
  /** 每轮请求前（第几轮）。 */
  onRound?(round: number): void;
  /** 模型要调工具了（工具名 + 参数）。 */
  onToolCall?(name: string, args: Record<string, unknown>): void;
  /** 工具执行完（无论成败——失败也是结果）。 */
  onToolResult?(name: string, ok: boolean, content: string): void;
}

export interface AgentTurnOptions {
  provider: Provider;
  /** 共享的会话历史，循环会往里追加消息（回合失败时回滚到进入前的长度）。 */
  messages: ChatMessage[];
  tools: ToolRegistry;
  system?: string;
  /** 轮数上限，默认 8（M3 实验同款默认值）。 */
  maxRounds?: number;
  /**
   * 权限门：needsApproval 的工具执行前要先过这里。
   * 不传 = 没有权限层（工具直接执行）——阶段 1 的形态。
   */
  gate?: PermissionGate;
  signal?: AbortSignal;
  hooks?: AgentHooks;
}

export interface AgentTurnResult {
  /** 最终回答；stopped === "max_rounds" 时为空串。 */
  content: string;
  /** answer = 自然停；max_rounds = 强制停。 */
  stopped: "answer" | "max_rounds";
  rounds: number;
  /** 整个回合（可能多轮请求）累计的 token 用量。 */
  usage?: Usage;
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { provider, messages, tools, system, signal, hooks, gate } = opts;
  const maxRounds = opts.maxRounds ?? 8;
  const startLen = messages.length; // 回合原子性的锚点：出错就回滚到这里
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  try {
    for (let round = 1; round <= maxRounds; round++) {
      hooks?.onRound?.(round);

      const result = await provider.chat(messages, {
        system,
        tools: tools.schemas(),
        signal,
      });
      if (result.usage) {
        totalUsage.inputTokens += result.usage.inputTokens;
        totalUsage.outputTokens += result.usage.outputTokens;
      }

      // ---- 模型不要工具：自然停，最终回答入历史，回合结束 ----
      if (!result.toolCalls?.length) {
        messages.push({ role: "assistant", content: result.content });
        return { content: result.content, stopped: "answer", rounds: round, usage: totalUsage };
      }

      // ---- 模型要工具：先原样回填它的话（无状态的模型不回填就失忆）----
      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });

      // 再逐个执行、逐条回传。工具执行不消耗网络，一般不会在中途被打断，
      // 但 execute 是 await 的——万一未来有慢工具被 abort 打断，
      // 下面的 catch 也会把整回合回滚，不会留下没对上号的 tool_call
      for (const call of result.toolCalls) {
        hooks?.onToolCall?.(call.name, call.args);

        // 权限门：写类工具（needsApproval）执行前先过用户确认。
        // 拒绝也是"结果"——原样喂回模型，让它调整方案而不是闷头重试（自愈机制）
        const tool = tools.get(call.name);
        if (tool?.needsApproval && gate) {
          const preview = tool.preview?.(call.args);
          const decision = await gate.check(call.name, preview);
          if (decision === "deny") {
            const denied = JSON.stringify({
              error: "用户拒绝了这次操作。不要原样重试；如果仍有必要，请换一种方案或向用户说明。",
            });
            hooks?.onToolResult?.(call.name, false, denied);
            messages.push({ role: "tool", toolCallId: call.id, content: denied });
            continue;
          }
        }

        const outcome = await tools.execute(call.name, call.args);
        hooks?.onToolResult?.(call.name, outcome.ok, outcome.content);
        messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
      }
    }

    // 轮数用尽：模型还想继续也不行。历史保持完整（最后一轮的工具结果都在），
    // 但没有最终回答——由 REPL 提示用户
    return { content: "", stopped: "max_rounds", rounds: maxRounds, usage: totalUsage };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    if (!aborted) {
      // 真错误（网络错等）：回滚到回合开始前，保持历史干净——
      // 失败的回合不留残迹，下一轮从头再来
      messages.length = startLen;
    }
    // 用户 Ctrl+C：进度保留在历史里。Ctrl+C 只能打断 provider 的网络调用，
    // 而打断那一刻的历史恰好总是协议合法的（要么停在"提问还没答"，
    // 要么停在"工具结果已回填、模型还没接话"）——下一条消息来了模型能接着干。
    // 这是阶段 0 实证过的"中断不丢上下文"哲学（v0.3 用户实测暴露了
    // 全量回滚的代价：被中断的任务模型彻底失忆，"继续"无从接起）
    throw e;
  }
}
