/**
 * tools.ts —— 工具框架：说明书（schema）与执行体（run）配对登记，统一执行。
 *
 * 阶段 1 的演示工具在 tools-demo.ts；阶段 2 的文件工具（read/write/list/edit）
 * 也会登记到同一张表上——框架只认 Tool 接口，不关心工具具体做什么。
 *
 * 两条执行期的铁规矩（都是学习期实证过的坑）：
 *  1. 工具出错不炸进程：错误原文降级成 {error: "..."} 喂回模型——
 *     模型看到错误会自己调整参数重试，这是 agent 自愈机制的原料（M3 实验）；
 *  2. 错误信息先脱敏再回传：Node 的 fs 错误原文带着绝对路径
 *     （如 ENOENT: D:\Users\jsl\...），原样回传等于把本机目录结构告诉模型
 *     （M5 实证，见 NOTES）。
 */

import { homedir } from "node:os";
import type { ToolSchema } from "./types.js";

/** 一个工具 = 说明书 + 执行体。run 的返回值会被 JSON.stringify 后喂回模型。 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  /** 标准 JSON Schema，描述 run 能接受什么参数。 */
  readonly parameters: Record<string, unknown>;
  /**
   * 写类工具设为 true：执行前要过权限门（用户 y/n/a 确认）。
   * 读类工具（read/list）不设——读自己工作区的文件是 agent 的基本权利。
   */
  readonly needsApproval?: boolean;
  /**
   * 确认弹窗里展示的"改动预览"（写类工具实现，如 diff）。
   * 预览生成失败不算错误（比如目标文件还不存在），返回 undefined 就行。
   */
  preview?(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

/** 错误信息脱敏：本机路径替换成 ~，防止目录结构外泄（M5 教训）。 */
function maskPaths(text: string): string {
  return text
    .replaceAll(homedir(), "~")
    .replaceAll(process.cwd(), ".");
}

export type ToolResult = { ok: true; content: string } | { ok: false; content: string };

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 按名取工具本体（agent 循环在执行前要用它判断 needsApproval / 生成预览）。 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 给 provider 层的说明书列表（中立格式，各协议自行翻译）。 */
  schemas(): ToolSchema[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /**
   * 只读子表（阶段 3 计划模式的硬约束底座）：滤掉所有写类工具，返回新表。
   * 计划模式下模型拿到的工具清单里根本没有写操作——"先计划再动手"
   * 不靠提示词恳求，靠让写工具物理不存在。实验②实证了为什么要这样：
   * system 明说"先说明计划再动手"，模型照样一个字不提（软约束的选择性遵循）；
   * 而写工具不在 schema 里时，模型就算幻觉出 write_file，执行器也只会回
   * "未知工具"，错误喂回后自愈机制接得住。
   */
  readOnlyView(): ToolRegistry {
    const view = new ToolRegistry();
    for (const t of this.list()) if (!t.needsApproval) view.register(t);
    return view;
  }

  /**
   * 执行一个工具调用。永远 resolve 不 reject——失败也是"结果"，
   * 由调用方（agent 循环）把 content 原样回传给模型。
   */
  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, content: JSON.stringify({ error: `未知工具: ${name}` }) };
    }
    try {
      const result = await tool.run(args);
      return { ok: true, content: JSON.stringify(result ?? { ok: true }) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, content: JSON.stringify({ error: maskPaths(message) }) };
    }
  }
}
