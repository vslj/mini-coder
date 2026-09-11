/**
 * sse.ts —— 协议无关的 SSE 行解析器。
 *
 * SSE（Server-Sent Events）的线格式：一段段文本，用空行分隔事件，
 * 事件内是 `data: ...` / `event: ...` 这样的行。流式 LLM 响应就是
 * 一条长连接上不断推来的这种文本。
 *
 * 解析器要屏蔽三个坑（每个都是真实踩过的）：
 *  1. 一条 `data:` 行可能跨 chunk 断开——必须缓冲到凑齐换行符才交出去；
 *  2. 中文字符可能被切在两个 chunk 中间——直接 chunk.toString() 会得到
 *     乱码，必须用 TextDecoder 的流式模式（它会把半个 UTF-8 序列留到下个 chunk）；
 *  3. 服务端可能发 `:` 开头的注释行（心跳/keepalive）——直接跳过。
 *
 * 刻意只产出"原始行"：OpenAI 分支和 Anthropic 分支对行的解释方式不同
 * （前者只认 data:，后者要把 event: 和 data: 配对），解释权留在各分支。
 */

// 可选观测：设 MINICODER_DEBUG=chunks 时把每个原始 chunk 打到 stderr。
// 用途：让"跨 chunk 的行边界"从不可见变成可见——平时关闭，不影响教学主线。
// 注意预览用一次性解码，chunk 恰好切在中文中间时预览里会出现 � ——这本身就
// 是"为什么必须流式解码"的现场演示。
const DEBUG_CHUNKS = process.env.MINICODER_DEBUG === "chunks";

/** 把响应字节流切成一条条完整的行（不含行尾换行符）。 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder(); // 流式解码：不完整的 UTF-8 序列自动留到下一轮
  let buffer = "";

  for await (const chunk of body) {
    if (DEBUG_CHUNKS) {
      const preview = new TextDecoder().decode(chunk).replaceAll("\n", "\\n").slice(0, 70);
      console.error(`[sse] chunk ${String(chunk.length).padStart(4)}B │ ${preview}`);
    }
    buffer += decoder.decode(chunk, { stream: true });
    // 按换行切分；最后一段可能不完整（行还没结束），留在缓冲区等下一个 chunk
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(":")) continue; // SSE 注释行：心跳/keepalive，不是数据
      yield line;
    }
  }

  // 流结束：把 decoder 里残留的字节 flush 出来（decoder.decode() 无参调用即 flush）
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}
