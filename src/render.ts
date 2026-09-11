/**
 * render.ts —— 把流式事件画到终端上。
 *
 * 视觉规则（复刻 M1 观察到的"两种 delta 接力"）：
 *   先到的是思维链（reasoning delta），用 ANSI 暗淡色显示，给人"草稿"感；
 *   正文（text delta）开始时恢复颜色，与前文之间空一行。
 *
 * 唯一的硬规则：正文 token 原样透传，控制符只在状态切换时输出。
 * 全程用 process.stdout.write 而不是 console.log——后者每次自动补换行，
 * 会把打字机效果打碎。
 */

// ANSI 色码集中在这里，将来要做降级检测（老旧 conhost）只改这两行
const DIM = "\x1b[2m"; // 暗淡色
const RESET = "\x1b[0m"; // 恢复默认

export interface Renderer {
  /** 处理一个流式事件（reasoning / text / done）。 */
  write(event: { type: string; text?: string; stopReason?: string }): void;
}

export function createRenderer(): Renderer {
  // 状态机只有一个维度：当前在画什么
  let phase: "idle" | "reasoning" | "text" = "idle";

  return {
    write(event) {
      if (event.type === "reasoning" && event.text) {
        if (phase !== "reasoning") {
          process.stdout.write(`\n${DIM}[思考] `);
          phase = "reasoning";
        }
        process.stdout.write(event.text);
        return;
      }
      if (event.type === "text" && event.text) {
        if (phase === "reasoning") {
          process.stdout.write(`${RESET}\n`); // 思维链结束：恢复颜色，空一行分隔音草稿与正文
        }
        process.stdout.write(event.text);
        phase = "text";
        return;
      }
      if (event.type === "done") {
        process.stdout.write("\n"); // 收尾换行
        phase = "idle";
      }
    },
  };
}
