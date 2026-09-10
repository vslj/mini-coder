// agent.mjs —— M3 毕业实验：~50 行裸 Agent
//
// 目的：亲眼看到一个 Agent 就是个 while 循环——
//   想(模型决策) → 做(程序执行工具) → 看结果(回填 messages) → 再想 …… 直到自然停或强制停。
//
// 两个真实工具：read_file / write_file，只能操作 learning/m3/sandbox/ 目录。
// 运行：
//   node agent.mjs "在沙盒里创建 hello.txt，内容写：你好，世界"
//   node agent.mjs "任务描述" 3        ← 第二个参数是最大迭代次数（默认 8），用于实验强制停

import { chat } from "../m2/lib.mjs"; // 复用 M2 的通道库——配置/请求逻辑不用重写
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = join(dirname(fileURLToPath(import.meta.url)), "sandbox");
if (!existsSync(SANDBOX)) mkdirSync(SANDBOX);

// ---------- 工具说明书：两个真实工具 ----------
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

// ---------- 工具执行：真实读写，但错误绝不让程序崩——错误也是给模型的反馈 ----------
function executeTool(call) {
  const args = JSON.parse(call.function.arguments);
  const filePath = join(SANDBOX, args.path); // 安全提示：没有防 ../ 逃逸，M5 再处理
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
    return { error: e.message }; // 读不存在的文件等错误 → 原样告诉模型，让它自己调整
  }
}

// ---------- Agent 主循环：整个 mini-coder 的原型 ----------
async function runAgent(userTask, maxIterations = 8) {
  const messages = [{ role: "user", content: userTask }];
  console.log(`任务: ${userTask}\n最大迭代上限: ${maxIterations}\n`);

  for (let round = 1; round <= maxIterations; round++) {
    const resp = await chat(messages, { tools });
    const msg = resp.choices[0].message;
    const reason = resp.choices[0].finish_reason;

    console.log(`---- 第 ${round} 轮 | messages=${messages.length} 条 | finish_reason=${reason} ----`);

    if (reason !== "tool_calls") {
      console.log(`>> 模型不再要求调用工具 → 自然停止\n`);
      console.log(`【最终回答】\n${msg.content}`);
      console.log(`\n共 ${round} 轮，token: 输入 ${resp.usage.prompt_tokens} / 输出 ${resp.usage.completion_tokens}`);
      return;
    }

    // 先原样回填模型的话（它无状态，不回填就失忆），再逐个执行、逐条回传
    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const result = executeTool(call);
      console.log(`>> ${call.function.name}(${call.function.arguments}) → ${JSON.stringify(result)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  console.log(`\n[强制停止] 已达最大迭代 ${maxIterations}，模型还想继续也不行——不设上限就可能无限烧 token`);
}

const task = process.argv[2];
if (!task) {
  console.error("用法: node agent.mjs \"任务描述\" [最大迭代次数]");
  process.exit(1);
}
runAgent(task, Number(process.argv[3]) || 8).catch((e) => {
  console.error("[Agent 失败]", e.message);
  process.exit(1);
});
