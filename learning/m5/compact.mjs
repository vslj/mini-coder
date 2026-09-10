// compact.mjs —— M5 实验 1：看着上下文膨胀，再亲手 /compact
//
// 目的：
//   ① 肉眼看到 token 成本曲线（每轮全额重发历史 → 成本近似轮数平方级）
//   ② 手动实现 /compact 的原理：让模型把旧历史摘要成短文本，替换掉
//   ③ 验证压缩后 Agent 还能不能"续上"工作——以及丢了什么
//
// 运行：node compact.mjs

import { chat, section } from "../m2/lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX = join(dirname(fileURLToPath(import.meta.url)), "sandbox");
if (!existsSync(SANDBOX)) mkdirSync(SANDBOX);

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取沙盒目录下某个文件的内容。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件名" } },
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
          path: { type: "string", description: "文件名" },
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
    if (call.function.name === "read_file") return { content: readFileSync(filePath, "utf8") };
    if (call.function.name === "write_file") {
      writeFileSync(filePath, args.content, "utf8");
      return { ok: true, path: args.path };
    }
    return { error: `未知工具: ${call.function.name}` };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- 阶段 1：串行任务，把上下文撑肥 ----------
// 任务故意设计成依赖链：写 note1 → 读 note1 才能写 note2 → 读 note2 才能写 note3……
// 依赖强制串行 → 轮数多 → 每轮历史里还躺着整个文件内容 → 膨胀得快
section("阶段 1：跑一个会膨胀的任务");
const task =
  "先创建 note1.txt 写一段不少于 80 字的编程学习笔记；" +
  "然后读 note1.txt，在其末尾追加一句话后保存为 note2.txt；" +
  "再读 note2.txt 追加一句话保存为 note3.txt；" +
  "同样方法做出 note4.txt 和 note5.txt。";
console.log(`任务：${task}\n`);

const messages = [{ role: "user", content: task }];
const tokenCurve = []; // 每轮的 prompt_tokens——成本曲线

for (let round = 1; round <= 12; round++) {
  const resp = await chat(messages, { tools });
  const msg = resp.choices[0].message;
  tokenCurve.push(resp.usage.prompt_tokens);
  console.log(`第 ${round} 轮 | messages=${messages.length} 条 | prompt_tokens=${resp.usage.prompt_tokens}`);

  if (resp.choices[0].finish_reason !== "tool_calls") {
    console.log(`>> 自然停止\n`);
    break;
  }
  messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
  for (const call of msg.tool_calls) {
    const result = executeTool(call);
    console.log(`   >> ${call.function.name}(${call.function.arguments.slice(0, 40)}...)`);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

section("阶段 1 观察点：成本曲线");
console.log(`每轮 prompt_tokens：${tokenCurve.join(" → ")}`);
console.log(`>> 曲线在爬坡——每轮都全额重发之前的一切。轮数越多爬得越陡（平方级趋势）。`);

// ---------- 阶段 2：手动 /compact ----------
// 注意两个细节：
//   1. 压缩请求不带 tools——摘要不需要工具说明书，还避免模型顺手去调工具
//   2. 压缩指令明确要求保留什么（目标/产出/状态）——丢什么留什么是你设计的，不是模型自己决定的
section("阶段 2：/compact —— 用摘要替换整个历史");
const compactResp = await chat([
  ...messages,
  {
    role: "user",
    content:
      "请把以上全部对话压缩成一份不超过 150 字的简报，必须包含：" +
      "任务目标、已产出哪些文件及每个文件的内容要点、当前状态。直接输出简报正文。",
  },
]);
const summary = compactResp.choices[0].message.content;
console.log(`压缩调用自身的输入 token：${compactResp.usage.prompt_tokens}（≈ 历史总成本，这就是 /compact 要付的一次性"赎身费"）`);
console.log(`\n【摘要】\n${summary}`);

// ---------- 阶段 3：短历史续命 ----------
section("阶段 3：丢掉旧历史，只带简报继续干活");
const slim = [
  {
    role: "user",
    content: `之前会话的简报：\n${summary}\n\n请继续：创建 index.txt，列出你产出过的所有文件名（一行一个）。`,
  },
];
console.log(`新 messages 只有 ${slim.length} 条。\n`);

const cont1 = await chat(slim, { tools });
const cmsg = cont1.choices[0].message;
console.log(`续命第一轮 prompt_tokens=${cont1.usage.prompt_tokens}（对比膨胀前的曲线起点）`);

if (cont1.choices[0].finish_reason === "tool_calls") {
  slim.push({ role: "assistant", content: cmsg.content, tool_calls: cmsg.tool_calls });
  for (const call of cmsg.tool_calls) {
    const result = executeTool(call);
    console.log(`   >> ${call.function.name}(${call.function.arguments}) → ${JSON.stringify(result)}`);
    slim.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  const cont2 = await chat(slim);
  console.log(`\n【续命后的最终回答】\n${cont2.choices[0].message.content}`);
}

section("阶段 3 观察点：压缩的代价");
console.log("1. 模型还记得产出过哪些文件吗？（任务目标保留得如何）");
console.log("2. 它还记得每个文件的具体内容吗？（细节丢掉了吗——这正是 /compact 的取舍）");
console.log("3. 如果细节很重要怎么办？提示：摘要保什么丢什么，是你写压缩指令时决定的。");
