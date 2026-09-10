// agent2.mjs —— M4 实验：同一个裸 Agent，戴上 system prompt 前后的行为对比
//
// 与 agent.mjs 的全部差异只有两处（用 diff 看一目了然）：
//   1. 多了 RULES（system prompt 文本）
//   2. messages 数组开头多一条 role:"system" 消息
// 核心循环、工具定义、执行逻辑一字未动——行为差异 100% 来自 system prompt。
//
// 运行：
//   node agent2.mjs "任务"          ← 带规则（实验组）
//   node agent2.mjs --bare "任务"   ← 不带规则（对照组，应与 agent.mjs 行为一致）

import { chat } from "../m2/lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = join(dirname(fileURLToPath(import.meta.url)), "sandbox");
if (!existsSync(SANDBOX)) mkdirSync(SANDBOX);

// ---------- 新增件 1：岗位说明书 ----------
// 三条规则分别对应三种可观察的行为：
//   规则 1 → "先读后写"（观察第一轮选什么工具）
//   规则 2 → 汇报简短（观察最终回答长度）
//   规则 3 → 不臆测文件存在（观察对不存在文件的行为）
const RULES = `你是一个终端编程助手 mini-coder。
规则（必须遵守）：
1. 要修改一个已存在的文件之前，必须先用 read_file 读取它的当前内容，禁止凭想象猜测文件内容。
2. 完成任务后，用不超过两句话向用户报告结果。
3. 不要假设文件存在，不确定时先用 read_file 确认。`;

// ---------- 工具定义：与 agent.mjs 完全相同 ----------
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取沙盒目录下某个文件的内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件名，例如 hello.txt" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把文本内容写入沙盒目录下的某个文件（覆盖式写入）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件名，例如 hello.txt" },
          content: { type: "string", description: "要写入的完整文本内容" },
        },
        required: ["path", "content"],
      },
    },
  },
];

function executeTool(call) {
  const args = JSON.parse(call.function.arguments);
  const filePath = join(SANDBOX, args.path);
  try {
    switch (call.function.name) {
      case "read_file":
        return { content: readFileSync(filePath, "utf8") };
      case "write_file":
        writeFileSync(filePath, args.content, "utf8");
        return { ok: true, path: args.path, bytes: args.content.length };
      default:
        return { error: `未知工具: ${call.function.name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

async function runAgent(userTask, maxIterations = 8, bare = false) {
  const system = bare ? null : RULES;

  // ---------- 新增件 2：messages 的第一条是 system ----------
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: userTask });

  console.log(`模式: ${bare ? "无规则（对照）" : "带 system prompt（实验组）"}`);
  console.log(`任务: ${userTask}\n`);

  for (let round = 1; round <= maxIterations; round++) {
    const resp = await chat(messages, { tools });
    const msg = resp.choices[0].message;
    const reason = resp.choices[0].finish_reason;

    console.log(`---- 第 ${round} 轮 | messages=${messages.length} 条 | finish_reason=${reason} ----`);

    if (reason !== "tool_calls") {
      console.log(`\n【最终回答】\n${msg.content}`);
      console.log(`\n共 ${round} 轮，token: 输入 ${resp.usage.prompt_tokens} / 输出 ${resp.usage.completion_tokens}`);
      return;
    }

    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const result = executeTool(call);
      console.log(`>> ${call.function.name}(${call.function.arguments}) → ${JSON.stringify(result)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  console.log(`\n[强制停止] 已达最大迭代 ${maxIterations}`);
}

// 解析命令行：slice(2) 去掉 node.exe 路径和脚本路径，剩下的才是用户参数
const args = process.argv.slice(2);
const bare = args.includes("--bare");
const task = args.find((a) => a !== "--bare");
if (!task) {
  console.error('用法: node agent2.mjs [--bare] "任务描述"');
  process.exit(1);
}
runAgent(task, 8, bare).catch((e) => {
  console.error("[Agent 失败]", e.message);
  process.exit(1);
});
