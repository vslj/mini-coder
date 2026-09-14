/**
 * tools-demo.ts —— 阶段 1 的两个无害演示工具。
 *
 * 选它们的理由（教学考量）：get_time **零参数**，让读者聚焦循环本身；
 * calculate **带参数**，验证"模型产出的参数能进到函数里"。
 * 一无一带，工具调用的两个面向就都覆盖了。
 *
 * 阶段 2 会换成真正的文件工具（read/write/list/edit）——框架不变，只换工具。
 */

import type { Tool } from "./tools.js";

/** get_time：报当前时间。零参数工具——连参数都不要的调用，最能看清循环骨架。 */
export const getTimeTool: Tool = {
  name: "get_time",
  description: "获取当前本地时间。",
  parameters: { type: "object", properties: {} },
  run() {
    return {
      time: new Date().toLocaleString("zh-CN", { hour12: false }),
      // 显式标注时区：模型不知道运行机器在哪，这个信息对它回答"现在几点"是必要的
      timezone: "本机时区",
    };
  },
};

/**
 * calculate：算四则运算。带参数工具——验证模型按 JSON Schema 产出参数的通路。
 *
 * 安全设计是这里的真教材：直接 eval 用户可控字符串是代码执行漏洞，
 * 所以先用白名单正则把关——只放行数字和四则运算符，其他一律拒绝。
 * 这道门是"参数校验"的最小示范，阶段 2 的文件工具会用到同一思路
 * （路径白名单），只是检查的东西更复杂。
 */
export const calculateTool: Tool = {
  name: "calculate",
  description: "计算一个四则运算表达式（支持 + - * / 和括号），返回结果。",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "算式，例如 (2+3)*4" },
    },
    required: ["expression"],
  },
  run(args) {
    const expr = String(args.expression ?? "");
    if (!expr) throw new Error("缺少 expression 参数");
    // 白名单：数字、四则运算符、括号、空白。一个字符都不多放。
    if (!/^[\d+\-*/().\s]+$/.test(expr)) {
      throw new Error(`表达式含非法字符，只允许数字和 + - * / ( ) : ${expr.slice(0, 50)}`);
    }
    // 过了白名单才放行 Function 求值（比 eval 稍好的写法，本质同理——所以白名单才是真正的门）
    const value = new Function(`"use strict"; return (${expr});`)() as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`表达式没有算出有限数字: ${expr}`);
    }
    return { expression: expr, result: value };
  },
};
