/**
 * errors.ts —— 结构化错误 + 重试退避。
 *
 * 背景（M5 的教训）：agent-hardened.mjs 里的 withRetry 只能靠正则从
 * `Error("HTTP 429: ...")` 的 message 字符串里抓状态码——因为非流式
 * chat() 把错误抛成了普通字符串。这是"用字符串当数据结构"的债，
 * 正式版从第一天就用结构化错误：kind + status 是字段，不是文字。
 */

/** 错误的三种来源：
 *  - http：服务端返回了响应，但状态码不是 2xx（status 字段必有值）
 *  - network：请求根本没到服务端（断网 / DNS / 连接被拒）
 *  - protocol：服务端返回 2xx 但响应体不是我们期待的形状（JSON 解析失败等）
 */
export type ErrorKind = "http" | "network" | "protocol";

export class ProviderError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 哪些 HTTP 状态值得重试：限流与网关类抖动；400/401/403 是永久错误，重试没有意义。 */
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

/** 可重试判定：网络层错误一律可试；HTTP 错误查白名单；protocol 错误是自己的 bug，不重试。 */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return false;
  if (e.kind === "network") return true;
  return e.kind === "http" && e.status !== undefined && RETRYABLE_STATUS.includes(e.status);
}

/**
 * 带指数退避的重试：只对 isRetryable 的错误重试，退避 1s → 2s → 4s，
 * 加随机抖动避免多个客户端同步重试（惊群）。
 * 退避公式与 M5 实测曲线同款（1114 → 2214 → 4388ms，见 learning/M5-学习总结.md）。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  label = "请求",
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= maxRetries) throw e;
      const backoff = 1000 * 2 ** attempt + Math.random() * 500;
      const status = e instanceof ProviderError ? `HTTP ${e.status}` : "网络错误";
      console.error(`[${label}] ${status}，${Math.round(backoff)}ms 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
