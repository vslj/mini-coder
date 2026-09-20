/**
 * compact.ts —— 上下文压缩（阶段 4）。
 *
 * 为什么要压缩（实验①的账本，详见 NOTES）：历史每轮全量重发，成本由历史
 * 长度驱动——历史里躺进一个大文件的读取结果后，之后每一轮的输入地板就是
 * 全部旧账（实测：读一个 287 行的文件输入 +11416 tokens，随后十几个字的
 * 短追问也要 +8631）。模型无状态，"记忆"只是客户端 messages 数组里的
 * 文本——数组是自己的，就能改。M1 的核心观察在这里变成机制。
 *
 * 设计决策一：计量走双轨。
 *   - 真实账：端点返回的 usage（/usage 展示用）——准确，但可能拿不到
 *     （MiMo 流式不给 usage，实测见 NOTES）；
 *   - 估算账：estimateTokens 自己算（自动触发的决策用）——粗，但永远可得。
 *   决策不能依赖端点给不给账，所以触发判断只认估算。
 *
 * 设计决策二：摘要 + 按体积封顶的保留尾部（M5 原型 compact.mjs 是全历史摘要）。
 *   - 旧历史压成一份简报，最近的回合原样保留——正在进行的任务状态不打折，
 *     "继续"能无缝接上（Claude Code 的 auto-compact 同款思路）；
 *   - 尾部按**体积**封顶而不是按条数（验收实测的教训：按条数保留最近 2 轮，
 *     尾巴恰好是两次大文件的读取结果时，保留段比被压缩的正文还肥，
 *     22813 → 29569 压了个寂寞——刀落下时肉都在尾巴上）；
 *   - 切口必须落在 user 消息边界：保留段从一条 user 消息开始到末尾，
 *     tool_calls 与 tool 结果的配对关系就永远不会被拦腰切断（协议合法性
 *     不靠检查靠构造——切错地方的话 OpenAI 会收到孤儿 tool_call_id，
 *     Anthropic 会收到没有 tool_use 对应的 tool_result 块）。
 */

import type { ChatMessage, Provider } from "./types.js";

/**
 * 自动压缩的阈值（估算 tokens）。给两种死法都留余量（实验①两种都见过）：
 * 远低于上下文窗口（超窗是协议层死法），也远低于"历史太肥把服务端打挂"
 * 的程度（HTTP 500 是服务层死法）。按所用模型的窗口大小调整。
 */
export const COMPACT_THRESHOLD = 60_000;

/**
 * 保留尾部的体积上限（估算 tokens）。最后一个回合无论如何保住——
 * 正在进行的任务状态全在里面，连续性优先于水位；哪怕它独自超限。
 */
export const KEEP_TAIL_TOKEN_CAP = 8_000;

/**
 * 估算一段文本的 token 数：CJK 字 ≈ 1 token/字，其他字符 ≈ 4 字符/token。
 * 粗账——目的不是精确，是量级正确：阈值判断只需要知道"6 万还是 8 万"，
 * 差 10% 无所谓。真实账（usage）才有精确值，两本账各管各的用途。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // CJK 统一表意文字区按 1 字 1 token 记；其余（含 ASCII、标点、空白）按 4:1 记
    const cp = ch.codePointAt(0)!; // for...of 遍历的就是码点，codePointAt(0) 必有值
    if (cp >= 0x4e00 && cp <= 0x9fff) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 整个历史的估算：每条消息加一点结构开销（role 字段、协议包装），宁高勿低。 */
export function estimateHistory(messages: ChatMessage[]): number {
  const body = messages.reduce((sum, m) => {
    let size = estimateTokens(m.content);
    if (m.toolCalls) size += Math.ceil(JSON.stringify(m.toolCalls).length / 4); // 调用参数也占上下文
    return sum + size;
  }, 0);
  return Math.ceil(body + messages.length * 8);
}

/** 压缩请求的指令。保什么丢什么在这里显式列出——这是设计者的决定，不是模型的（M5 的核心结论）。 */
const COMPACT_PROMPT =
  "请把以上对话历史压缩成一份简报（不超过 500 字），必须包含：\n" +
  "1. 任务目标（含仍在进行中的部分）；\n" +
  "2. 已完成的操作与产出的文件（文件名 + 内容要点）；\n" +
  "3. 未完成的部分与下一步；\n" +
  "4. 用户明确表达过的偏好、约束或纠正。\n" +
  "直接输出简报正文，不要寒暄。";

export interface CompactResult {
  /** 模型产出的简报正文。 */
  summary: string;
  /** 原样保留的尾部回合（从一条 user 消息开始到历史末尾，体积 ≤ 上限）。 */
  kept: ChatMessage[];
  /** 被替换部分的估算 token → 摘要+保留段的估算 token（展示用，让用户看见省了多少）。 */
  beforeTokens: number;
  afterTokens: number;
  /** 保留段的估算 token（单列出来，压缩效果被尾巴吃掉时一眼可见）。 */
  keptTokens: number;
}

/** 把简报包装成进历史的第一条消息：明确告诉模型"逐条对话已被替换"。 */
export function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content: `〔历史已压缩〕以下是之前会话的简报，之前的逐条对话已被替换为这份简报：\n${summary}`,
  };
}

/**
 * 压缩历史：旧段（切口之前的所有消息）让模型总结成简报，返回替换材料。
 * 刻意不改传入的 messages 数组——替换由调用方（REPL）执行，压缩失败时
 * 历史原封不动，不需要回滚逻辑。
 *
 * 返回 null = 不值得压或压不出结果（历史太短/模型返回空）——同样是
 * "历史保持原样"，调用方统一按没压缩处理。
 */
export async function compactMessages(
  messages: ChatMessage[],
  provider: Provider,
): Promise<CompactResult | null> {
  // 找切口：从最后一个回合往前扫，体积装得进 KEEP_TAIL_TOKEN_CAP 的最早
  // 回合边界就是切口——尾部尽量多留、但总量封顶。从后往前积累只会变大，
  // 一旦超限即可停（更早的边界只会更肥）。
  const userTurns: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") userTurns.push(i);
  }
  let cut: number | undefined;
  for (let k = userTurns.length - 1; k >= 0; k--) {
    const start = userTurns[k]!;
    if (estimateHistory(messages.slice(start)) <= KEEP_TAIL_TOKEN_CAP) cut = start;
    else break;
  }
  // 一个都装不下（最后一个回合独自超限）：仍然保住最后一个回合——
  // 正在进行的任务状态全在里面，连续性优先于水位
  if (cut === undefined) cut = userTurns[userTurns.length - 1];
  // 没有切口（历史为空等）：没东西可压
  if (cut === undefined || cut <= 0) return null;

  const replaced = messages.slice(0, cut);
  const kept = messages.slice(cut);

  // 摘要请求刻意不带 tools（M5 原型的两个细节之一）：摘要不需要工具说明书，
  // 也不给模型顺手调工具的机会——历史里全是工具往返时，带 tools 的话模型
  // 可能"演"工具（阶段 1 实测的诱导现象在摘要场景同样会生效）
  const resp = await provider.chat([...replaced, { role: "user", content: COMPACT_PROMPT }]);
  const summary = resp.content.trim();
  if (!summary) return null; // 模型返回空：宁可放弃也不往历史里塞空简报

  return {
    summary,
    kept,
    beforeTokens: estimateHistory(replaced),
    afterTokens: estimateHistory([buildSummaryMessage(summary), ...kept]),
    keptTokens: estimateHistory(kept),
  };
}
