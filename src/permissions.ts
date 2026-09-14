/**
 * permissions.ts —— 权限门：写类工具执行前的最后一道关卡。
 *
 * 为什么做成接口而不是写死在 REPL 里：agent 循环只依赖 PermissionGate
 * 接口——交互式确认（人看着 diff 按 y/n/a）与自动放行（测试/CI 场景）
 * 可以互换，循环本身一行不改。这是"策略与机制分离"的最小示范。
 *
 * 交互实现的三个语义（对照 Claude Code 的权限弹窗）：
 *   y = 允许这一次；n（或空输入）= 拒绝这一次；a = 本会话内该工具不再确认。
 *   权限记忆是纯内存的会话状态，不落盘——重启即回到逐次确认，
 *   "危险能力默认收紧"是安全设计的默认姿态。
 *
 * Ctrl+C 的语义扩展：确认弹窗中按 ^C = 拒绝当前操作（不是退出程序）。
 * 实现走了一个巧门：^C 在熟模式下是进程级 SIGINT，REPL 的信号处理器
 * 调 cancelPending()，它用 rl.write("n\n") 模拟用户敲了 n——
 * 挂起的确认输入自然按"拒绝"结算，不用去和 readline 的内部状态搏斗。
 */

/** 确认输入所需的 I/O 能力（结构化最小接口，测试时可注入替身）。 */
export interface ConfirmIO {
  question(prompt: string): Promise<string>;
  /** 向 readline 模拟"用户敲入的数据"（Ctrl+C 拒绝路径用它喂入 "n"）。 */
  write(data: string): void;
  pause(): void;
  resume(): void;
}

export type PermissionDecision = "allow" | "deny";

export interface PermissionGate {
  /** 工具执行前调用；resolve 即决定。preview 是给人看的改动预览（可为空）。 */
  check(toolName: string, preview?: string): Promise<PermissionDecision>;
  /** Ctrl+C 路径：拒绝当前挂起的确认。没有挂起中的确认时返回 false。 */
  cancelPending(): boolean;
}

/** 测试/无人值守场景：一律放行。 */
export function createAllowAllGate(): PermissionGate {
  return {
    check: async () => "allow",
    cancelPending: () => false,
  };
}

export function createInteractiveGate(io: ConfirmIO): PermissionGate {
  /** 会话级记忆：用户按过 a 的工具名。 */
  const allowed = new Set<string>();
  let pending = false;

  return {
    async check(toolName, preview) {
      if (allowed.has(toolName)) return "allow";

      pending = true;
      process.stdout.write("\n");
      if (preview) {
        process.stdout.write(preview + "\n");
      } else {
        process.stdout.write(`${DIM_RENDER}(没有改动预览)${DIM_RESET}\n`);
      }
      io.resume(); // agent 回合期间 readline 处于暂停态，确认输入要临时接管
      const ans = (await io.question(`允许执行 ${toolName} 吗？(y=允许 / n=拒绝 / a=本会话都允许) `))
        .trim()
        .toLowerCase();
      io.pause();
      pending = false;

      if (ans === "a") {
        allowed.add(toolName);
        process.stdout.write(`（本会话内 ${toolName} 将不再确认）\n`);
        return "allow";
      }
      if (ans === "y") return "allow";
      // 空输入/其他输入一律拒绝：权限问题宁可错杀
      process.stdout.write("（已拒绝——这个结果会喂回模型）\n");
      return "deny";
    },

    cancelPending() {
      if (!pending) return false;
      pending = false;
      io.write("n\n"); // 让挂起的确认按"拒绝"结算
      return true;
    },
  };
}

// 预览缺失的提示色（暗淡）；不复用 render.ts 的常量，权限层不依赖渲染层
const DIM_RENDER = "\x1b[2m";
const DIM_RESET = "\x1b[0m";
