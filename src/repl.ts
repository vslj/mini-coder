/**
 * repl.ts —— REPL 主循环：用户-facing 的一切。
 *
 * 交互模型：
 *   > 用户输入 ──→ 内建命令？（硬编码 if/else，命令系统是阶段 4 的事）
 *              └─→ chatStream 边流边画 → assistant 消息入历史 → 回到提示符
 *
 * 两个精心处理过的点（都是真实会踩的坑）：
 *  1. 流式期间 rl.pause()：readline 若继续监听，用户按键回显会打碎打字机画面；
 *  2. Ctrl+C 两态语义：空闲态（readline 接管输入）在 rl 的 SIGINT 事件里退出；
 *     流式态（readline 已暂停）走进程级 SIGINT → abort 请求 → 回到提示符。
 *     signal 从这里一路穿透到 provider 内部的 fetch。
 */

import * as readline from "node:readline/promises";
import { createRenderer } from "./render.js";
import type { ChatMessage, Provider, Usage } from "./types.js";

export interface ReplOptions {
  /** 可热切换的 provider 表（键 = provider 名）。 */
  providers: Record<string, Provider>;
  initial: string;
}

export async function startRepl({ providers, initial }: ReplOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 会话状态：纯内存，不持久化（持久化/存档是阶段 2 的 agent 场景需求）
  const messages: ChatMessage[] = [];
  let currentName = initial;
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  let usageCount = 0; // 有多少轮真的拿到了 usage（MiMo 流式拿不到，见 NOTES）
  let currentAbort: AbortController | null = null;

  // 空闲态 Ctrl+C：readline 正接管输入，^C 走 rl 自己的 SIGINT 事件
  rl.on("SIGINT", () => {
    console.log("\n(再见)");
    process.exit(130);
  });
  // 输入流结束（EOF / Ctrl+D / 管道喂完）：干净退出，别让 question 悬着等 forever
  rl.on("close", () => {
    console.log("\n(输入结束，再见)");
    process.exit(0);
  });
  // 流式态 Ctrl+C：readline 已暂停，^C 是进程级信号 → 中断当前请求
  process.on("SIGINT", () => currentAbort?.abort());

  const renderer = createRenderer();

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
    if (line === "/help") {
      console.log("/exit 退出 | /clear 清空历史 | /usage 查看累计 token | /provider [名称] 切换协议通道");
      continue;
    }
    if (line.startsWith("/")) {
      console.log(`未知命令 ${line.split(" ")[0]}，/help 查看可用命令`);
      continue;
    }

    // ---- 正常对话 ----
    const provider = providers[currentName]!;
    messages.push({ role: "user", content: line });

    rl.pause(); // 暂停输入监听：流式输出期间不能让按键回显打碎画面
    currentAbort = new AbortController();
    let partial = ""; // 中断时记录已流出的正文，别让半截回答凭空消失

    try {
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
        { signal: currentAbort.signal },
      );
      // 入历史的 assistant 消息只带 content（reasoning 是瞬时字段，类型上就带不进历史）
      messages.push({ role: "assistant", content: result.content });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // 用户中断：有半截回答就入历史（标注截断），没有就撤回这条提问
        process.stdout.write("\n[已中断]\n");
        if (partial) {
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
      rl.resume();
    }
  }
}
