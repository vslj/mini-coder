/**
 * types.ts —— 两个 provider 共同"说"的语言。
 *
 * 这是 provider 抽象层的核心文件：REPL 和未来的 agent 循环只认这里的类型，
 * 永远不直接接触 OpenAI/Anthropic 的协议细节。
 *
 * 为什么自定义中立格式，而不是直接用某一家的协议？
 *   - OpenAI 的 reasoning_content 是厂商私有字段，不配当"标准"；
 *   - Anthropic 的 content 是块数组、system 是顶层参数，阶段 0 纯文本对话
 *     用不上块类型的表达力，读者第一课就会被淹没；
 *   - 中立格式最薄，两个 provider 各自显式做映射——"协议差异"本身
 *     就是我们最想展示的东西（见 providers/openai.ts 与 anthropic.ts 的对照）。
 *
 * 一个刻意的设计：system 不放进 messages 数组。
 *   OpenAI 把 system 当第一条消息，Anthropic 把它当顶层参数——两大协议
 *   在这里分歧最大。把 system 独立成一个字段，这个分歧就被吸收在
 *   provider 内部，调用方完全无感。
 */

export type Role = "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
  /**
   * 思维链原文，仅用于"刚刚这一轮"的展示。
   * 它是可选项，而且历史回传时只取 content——用类型系统把
   * "reasoning 不回传下一轮"变成结构性约束，而不是注释里的提醒。
   * （M1 实证：DeepSeek/MiMo 的 reasoning 不该回传，服务端宽容忽略不可依赖）
   */
  reasoning?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 停止原因已归一化：OpenAI 的 stop/length、Anthropic 的 end_turn/max_tokens 各归其位。 */
export type StopReason = "stop" | "length" | "other";

export interface ChatResult {
  content: string;
  reasoning?: string;
  /** 流式下 MiMo 可能不给 usage（实测见 NOTES），类型上允许缺省。 */
  usage?: Usage;
  stopReason: StopReason;
}

export interface ChatOptions {
  /** 顶层 system prompt，两个 provider 各自落到协议的正确位置。 */
  system?: string;
  /** 中断通道：REPL 的 Ctrl+C 会触发 abort，fetch 收到 signal 就停。 */
  signal?: AbortSignal;
}

/**
 * 流式事件的统一形状。reasoning 与 text 两种 delta 会接力出现
 * （先思维链、后正文，M1 的 SSE 观察在 OpenAI/Anthropic 两家都成立）。
 *
 * 刻意不设 error 事件：流中途的协议错误走 Promise reject（ProviderError），
 * 错误通道只有一条，教学上更清楚。
 */
export type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason: StopReason };

/**
 * provider 接口：REPL 只认这个接口，不认任何具体实现。
 * chatStream 用"回调 + resolve 完整结果"而不是 async generator——
 * `switch (e.type)` 的分发写法对读者更平易，且"边流边画、流完拿全文"
 * 正好匹配 REPL 的需求（generator 版本在博客里作为另一种写法提一句即可）。
 */
export interface Provider {
  readonly name: "openai" | "anthropic";
  /** 非流式：一次请求拿完整结果。 */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** 流式：边到边回调，Promise resolve 时返回拼好的完整结果。 */
  chatStream(
    messages: ChatMessage[],
    onEvent: (e: StreamEvent) => void,
    opts?: ChatOptions,
  ): Promise<ChatResult>;
}
