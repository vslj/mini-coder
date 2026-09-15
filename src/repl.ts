/**
 * repl.ts —— REPL 主循环：用户-facing 的一切。
 *
 * 交互模型（阶段 1 起两种模式并存，/tools 切换）：
 *   > 用户输入 ──→ 内建命令？（硬编码 if/else，命令系统是阶段 4 的事）
 *              ├─→ 纯聊天模式：chatStream 边流边画（阶段 0 的形态）
 *              └─→ agent 模式：runAgentTurn 工具循环（非流式，画工具活动）
 *
 * 两个精心处理过的点（都是真实会踩的坑）：
 *  1. 流式期间 rl.pause()：readline 若继续监听，用户按键回显会打碎打字机画面；
 *  2. Ctrl+C 两态语义：空闲态（readline 接管输入）在 rl 的 SIGINT 事件里退出；
 *     流式态（readline 已暂停）走进程级 SIGINT → abort 请求 → 回到提示符。
 *     signal 从这里一路穿透到 provider 内部的 fetch。
 */

import * as readline from "node:readline/promises";
import { runAgentTurn, type AgentTurnResult } from "./agent.js";
import { createInteractiveGate, type PermissionGate } from "./permissions.js";
import { createRenderer } from "./render.js";
import type { ToolRegistry } from "./tools.js";
import type { ChatMessage, Provider, Usage } from "./types.js";

// ANSI 色码（与 render.ts 同款）：agent 模式的工具活动行用暗淡色，跟正文区分
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** 计划模式的 system 补充段：/plan 时拼在主 system 后面（阶段 3）。 */
const PLAN_MODE_SYSTEM =
  "〔计划模式〕你现在处于计划模式：工具清单里只有只读工具（读文件、列目录等），" +
  "任何写操作都不可用。请先用只读工具了解与任务相关的情况，然后输出一份简短的" +
  "行动计划（做什么、改哪些文件、按什么顺序），不要执行任何修改。" +
  "计划输出后本回合即结束，计划会交给用户批准。";

export interface ReplOptions {
  /** 可热切换的 provider 表（键 = provider 名）。 */
  providers: Record<string, Provider>;
  initial: string;
  /** 工具注册表；提供时 agent 模式可用（默认开启）。 */
  tools?: ToolRegistry;
  /** 顶层 system prompt（两种模式共用）。 */
  system?: string;
}

export async function startRepl({ providers, initial, tools, system }: ReplOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 会话状态：纯内存，不持久化（持久化/存档是阶段 2 的 agent 场景需求）
  const messages: ChatMessage[] = [];
  let currentName = initial;
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let usageCount = 0; // 有多少轮真的拿到了 usage（MiMo 流式拿不到，见 NOTES）
  let currentAbort: AbortController | null = null;
  // agent 模式默认开（有工具就用）；/tools off 可切回纯聊天对照
  let agentMode = tools !== undefined;
  // 权限门：写类工具的 y/n/a 确认。挂在 rl 上——确认输入就是普通的一行输入
  const gate: PermissionGate | undefined = tools ? createInteractiveGate(rl) : undefined;
  // 计划批准框（/plan 流程）的挂起状态——Ctrl+C 巧门与确认弹窗同款
  let planPending = false;
  let planCancelled = false;

  // Ctrl+C 两态。Windows 上有个隐蔽机制：readline 创建后终端进入"生模式"
  // （raw mode），Ctrl+C 不再产生进程级 SIGINT，而是变成 \x03 字符交给
  // readline 解释成 rl 自己的 SIGINT 事件。所以：
  //  - 空闲态（readline 接管输入）：^C 走下面的 rl SIGINT → 退出；
  //  - 流式态（rl.pause 且终端被我们临时切回"熟模式"）：^C 恢复为真正的
  //    进程 SIGINT，走 process 级监听 → 中断当前请求。
  // （教训：流式中若只 pause 不切模式，\x03 会滞留在输入缓冲区，
  //   表现为"Ctrl+C 没反应，多按几次后突然退出"——积压的 ^C 迟到处理）
  rl.on("SIGINT", () => {
    console.log("\n(再见)");
    process.exit(130);
  });
  process.on("SIGINT", () => {
    // 优先级 1：确认弹窗挂起中——^C = 拒绝当前操作，不是退出
    if (gate?.cancelPending()) return;
    // 优先级 2：计划批准框挂起中——^C = 放弃计划，不是退出（同款巧门）
    if (planPending) {
      planCancelled = true;
      planPending = false;
      rl.write("n\n"); // 让挂起的批准输入按"放弃"结算（下面靠 planCancelled 识别真相）
      return;
    }
    if (currentAbort) {
      currentAbort.abort(); // 流式中：中断请求，回到提示符
    } else {
      console.log("\n(再见)"); // 兜底（非 TTY 等场景下没有 rl SIGINT）
      process.exit(130);
    }
  });
  // 输入流结束（EOF / Ctrl+D / 管道喂完）：干净退出，别让 question 悬着等 forever
  rl.on("close", () => {
    console.log("\n(输入结束，再见)");
    process.exit(0);
  });
  // 流式态 Ctrl+C 的中断逻辑已并入上面的主 SIGINT 处理器（优先级：确认弹窗 > 请求中断 > 退出）

  const renderer = createRenderer();

  /**
   * 跑一个 agent 回合并负责"人看的部分"：画工具活动、累计 usage、
   * 按停止原因收尾。agent 模式与计划模式的回合都走这一个入口。
   */
  const agentTurnWithUi = async (activeTools: ToolRegistry, systemExtra?: string): Promise<AgentTurnResult> => {
    const result = await runAgentTurn({
      provider: providers[currentName]!,
      messages,
      tools: activeTools,
      system: systemExtra ? `${system}\n${systemExtra}` : system,
      gate,
      signal: currentAbort!.signal,
      hooks: {
        onToolCall(name, args) {
          // 参数截断展示：write_file 的 content 参数可能几千字，终端只画个开头
          const shown = JSON.stringify(args);
          process.stdout.write(`${DIM}⚙ ${name}(${shown.length > 120 ? `${shown.slice(0, 120)}…` : shown})`);
        },
        onToolResult(_name, ok, content) {
          // 结果截断展示：完整内容已经进历史喂给模型了，终端只画个概要
          const brief = content.length > 100 ? `${content.slice(0, 100)}…` : content;
          process.stdout.write(` ${RESET}${ok ? "→" : "✗"} ${brief}\n`);
        },
      },
    });
    if (result.usage) {
      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;
      usageCount++;
    }
    if (result.stopped === "answer") {
      console.log(result.content);
    } else if (result.stopped === "cancelled") {
      // 确认弹窗里的 Ctrl+C：与流式中断同一套话术——进度保留，"继续"能接上
      console.log(`[回合已被 Ctrl+C 中止，任务进度已保留，直接说"继续"即可接着做]`);
    } else {
      console.log(
        `[已达 ${result.rounds} 轮上限，强制停止——模型可能在工具调用里打转，试试换个问法或 /clear]`,
      );
    }
    return result;
  };

  console.log(`mini-coder 就绪 —— 当前 provider: ${currentName}，输入 /help 查看命令`);

  while (true) {
    const line = (await rl.question("> ")).trim();
    if (!line) continue;

    // ---- 内建命令（硬编码分发；/provider 无参查看、带参热切换）----
    if (line === "/exit") {
      rl.close();
      console.log("(再见)");
      return;
    }
    if (line === "/clear") {
      messages.length = 0; // "失忆"的本质：客户端清空自己的数组（M1 的核心观察）
      console.log("(历史已清空)");
      continue;
    }
    if (line === "/usage") {
      console.log(
        `本会话累计 ${usageCount} 轮有账：输入 ${totalUsage.inputTokens} + 输出 ${totalUsage.outputTokens} tokens` +
          (usageCount === 0 ? "（流式下 MiMo 不回 usage，数字为空属正常，见 NOTES）" : ""),
      );
      continue;
    }
    if (line === "/provider") {
      console.log(`可用: ${Object.keys(providers).join(", ")} | 当前: ${currentName}`);
      continue;
    }
    if (line.startsWith("/provider ")) {
      const name = line.slice("/provider ".length).trim();
      if (providers[name]) {
        currentName = name;
        console.log(`(已切换到 ${name})`);
      } else {
        console.log(`没有这个 provider，可用: ${Object.keys(providers).join(", ")}`);
      }
      continue;
    }
    if (line === "/tools" || line.startsWith("/tools ")) {
      if (!tools) {
        console.log("(本次启动没有注册任何工具)");
        continue;
      }
      const arg = line.slice("/tools".length).trim();
      if (arg === "on" || arg === "off") {
        agentMode = arg === "on";
        console.log(`（agent 模式已${agentMode ? "开启" : "关闭"}——${agentMode ? "工具循环" : "纯聊天流式"}）`);
        continue;
      }
      console.log(`已注册工具（agent 模式：${agentMode ? "开" : "关"}）:`);
      for (const t of tools.list()) {
        console.log(`  ${t.name}${t.needsApproval ? " 🔒" : ""} —— ${t.description}`);
      }
      console.log("（🔒 = 写类工具，执行前需要确认）");
      continue;
    }
    // 计划模式（阶段 3）：参数校验在这里，执行落在底部的执行段，
    // 与普通输入共用同一套 try/catch/finally（错误与中断语义不另起炉灶）
    const isPlan = line === "/plan" || line.startsWith("/plan ");
    const planTask = isPlan ? line.slice("/plan".length).trim() : "";
    if (isPlan && !tools) {
      console.log("(本次启动没有注册任何工具，计划模式不可用)");
      continue;
    }
    if (isPlan && !planTask) {
      console.log("用法：/plan <任务描述> —— 模型先用只读工具摸清情况并给出计划，你批准后才动手");
      continue;
    }
    if (line === "/help") {
      console.log(
        "/exit 退出 | /clear 清空历史 | /usage 查看累计 token | /provider [名称] 切换协议通道 | /tools [on|off] 工具列表/agent 模式开关 | /plan <任务> 计划模式（只读侦察→批准→执行）",
      );
      continue;
    }
    if (line.startsWith("/") && !isPlan) {
      console.log(`未知命令 ${line.split(" ")[0]}，/help 查看可用命令`);
      continue;
    }

    // ---- 正常对话（纯聊天 / agent / 计划模式共用同一份 messages 历史）----
    const provider = providers[currentName]!;
    messages.push({ role: "user", content: isPlan ? planTask : line });

    rl.pause(); // 暂停输入监听：流式输出期间不能让按键回显打碎画面
    // 切回"熟模式"：让 Ctrl+C 重新成为进程级信号（生模式下它是滞留缓冲区的 \x03）
    process.stdin.setRawMode?.(false);
    currentAbort = new AbortController();
    let partial = ""; // 中断时记录已流出的正文，别让半截回答凭空消失

    try {
      if (isPlan) {
        // ---- 计划模式：阶段 3 的核心机制，实验②教训落成硬约束 ----
        // 提示词要求"先亮计划"被模型完全无视（软约束的选择性遵循），
        // 那就让"先计划"成为它唯一能干的事：这一回合的工具表换成只读
        // 子表，写操作从 schema 里物理消失；模型自然停下时输出的就是计划。
        console.log(`${DIM}〔计划模式：只读工具可用——先摸上下文，再给计划〕${RESET}`);
        const planResult = await agentTurnWithUi(tools!, PLAN_MODE_SYSTEM);
        if (planResult.stopped !== "answer" || !planResult.content.trim()) {
          // 没产出计划（轮数用尽/被中止/空回答）：任务还在历史里，用户可补充信息重试
          console.log("（计划模式没有产出计划——看上面的停止原因；任务仍在历史里，可补充信息后重试）");
        } else {
          // 批准框：与确认弹窗同一套 Ctrl+C 巧门（合成 n 结算 + 改写回显行）
          planPending = true;
          planCancelled = false;
          rl.resume(); // agent 回合期间 readline 处于暂停态，批准输入要临时接管
          const ans = (await rl.question("按此计划执行？(y=按计划执行 / 其他=放弃) ")).trim().toLowerCase();
          rl.pause();
          planPending = false;
          if (planCancelled) {
            process.stdout.write("\x1b[1A\x1b[2K（Ctrl+C —— 计划未执行）\n");
            messages.push({ role: "user", content: "计划未获批准，等待用户的新指示。" });
          } else if (ans === "y") {
            // 计划作为 assistant 消息已在历史里，模型执行时看得见自己许诺过什么——
            // 这正是"先分析后动手"能被检验的原因：说好的计划就摆在上下文里
            messages.push({ role: "user", content: "计划已获批准，请按计划执行。" });
            console.log(`${DIM}〔执行模式：全量工具可用〕${RESET}`);
            await agentTurnWithUi(tools!);
          } else {
            console.log("（计划未执行——计划保留在历史里，可以直接说修改意见让我调整）");
            messages.push({ role: "user", content: "计划未获批准，等待用户的新指示。" });
          }
        }
      } else if (agentMode && tools) {
        // ---- agent 模式：非流式工具循环，画的是"工具活动"而不是打字机 ----
        await agentTurnWithUi(tools);
      } else {
        // ---- 纯聊天模式：阶段 0 的流式打字机 ----
        const result = await provider.chatStream(
          messages,
          (e) => {
            if (e.type === "text") partial += e.text;
            renderer.write(e);
            if (e.type === "usage") {
              totalUsage.inputTokens += e.usage.inputTokens;
              totalUsage.outputTokens += e.usage.outputTokens;
              usageCount++;
            }
          },
          { signal: currentAbort.signal, system },
        );
        // 入历史的 assistant 消息只带 content（reasoning 是瞬时字段，类型上就带不进历史）
        messages.push({ role: "assistant", content: result.content });
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // 用户中断：两种模式语义不同
        process.stdout.write("\n[已中断]\n");
        if (isPlan || (agentMode && tools)) {
          // agent/计划模式：进度保留在历史（agent.ts 只回滚真错误）——
          // 说"继续"模型就能接着干，这里绝不能 pop
          process.stdout.write(`[任务进度已保留，直接说"继续"即可接着做]\n`);
        } else if (partial) {
          // 纯聊天模式：有半截回答就入历史（标注截断），没有就撤回这条提问
          messages.push({ role: "assistant", content: `${partial}\n[回答被用户中断]` });
        } else {
          messages.pop();
        }
      } else if (e instanceof Error && e.name === "ProviderError") {
        const err = e as Error & { kind?: string; status?: number };
        console.error(`\n[provider 错误 ${err.kind ?? "?"}${err.status ? ` HTTP ${err.status}` : ""}] ${err.message}`);
        messages.pop(); // 请求失败，撤回提问，避免下次带着孤立 user 消息
      } else {
        console.error(`\n[意外错误] ${e instanceof Error ? e.stack ?? e.message : e}`);
        messages.pop();
      }
    } finally {
      currentAbort = null;
      // 还原"生模式"：readline 的行编辑依赖它；再恢复输入监听
      process.stdin.setRawMode?.(true);
      rl.resume();
    }
  }
}
