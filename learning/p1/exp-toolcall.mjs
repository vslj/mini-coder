// exp-toolcall.mjs —— 阶段 1 实验①：工具调用在 MiMo 双端点上的真实形状
//
// 目的：阶段 0 只实测过纯文本流式。写 src/ 的 provider 层之前，先亲眼确认：
//   1. 两个端点是否都支持工具调用？
//   2. "模型要调工具"时响应长什么样（字段名、arguments 是字符串还是对象）？
//   3. 把工具执行结果回传后，模型能否给出最终回答？
// 每个端点走完整一轮回：问时间 → 要工具 → 执行 → 回传 → 最终回答。
//
// 运行：node exp-toolcall.mjs
// （key 全程只在内存里流转，输出不含 key，符合 ROADMAP 协作规则 2）

import { CFG, chat, section } from "../m2/lib.mjs";

// anthropic 端点从 .env 读（m2 的 loadEnv 没管这个变量，这里补一行）
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function anthropicUrl() {
  if (process.env.XIAOMI_ANTHROPIC_URL) return process.env.XIAOMI_ANTHROPIC_URL;
  const p = join(REPO_ROOT, ".env");
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/^\s*XIAOMI_ANTHROPIC_URL\s*=\s*(.*?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

// ---------- 演示工具：get_time（无害，实验焦点在协议形状不在工具本身） ----------
const TIME = () =>
  new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

const OPENAI_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "获取当前时间（北京时间）。",
      parameters: { type: "object", properties: {} },
    },
  },
];

const ANTHROPIC_TOOLS = [
  {
    name: "get_time",
    description: "获取当前时间（北京时间）。",
    input_schema: { type: "object", properties: {} },
  },
];

const QUESTION = "现在几点了？请用工具查一下再回答。";

// ============================================================
// 第一部分：OpenAI 兼容端点 /v1
// ============================================================
async function expOpenAI() {
  section("A. OpenAI 兼容端点 /v1 —— 第一跳：模型要调工具吗");
  const messages = [{ role: "user", content: QUESTION }];

  const resp1 = await chat(messages, { tools: OPENAI_TOOLS });
  const choice = resp1.choices[0];
  console.log(`finish_reason = ${choice.finish_reason}`);
  console.log("message 原始形状（截断到 800 字符）:");
  console.log(JSON.stringify(choice.message, null, 2).slice(0, 800));

  const calls = choice.message.tool_calls;
  if (!calls) {
    console.log("!! 模型没有要求调用工具（可能不支持 tools 参数，或模型自行回答了）");
    return;
  }
  for (const c of calls) {
    console.log(`>> 要调: ${c.function.name}  arguments=${JSON.stringify(c.function.arguments)}  (类型: ${typeof c.function.arguments})`);
  }

  section("A. 第二跳：执行工具，把结果回传");
  messages.push({ role: "assistant", content: choice.message.content, tool_calls: calls });
  for (const c of calls) {
    const result = { time: TIME() };
    console.log(`>> 执行 ${c.function.name}() → ${JSON.stringify(result)}`);
    messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result) });
  }

  const resp2 = await chat(messages);
  console.log(`finish_reason = ${resp2.choices[0].finish_reason}`);
  console.log(`最终回答: ${resp2.choices[0].message.content}`);
  if (resp2.usage) {
    console.log(`token: 输入 ${resp2.usage.prompt_tokens} / 输出 ${resp2.usage.completion_tokens}`);
  }
}

// ============================================================
// 第二部分：Anthropic 原生端点 /anthropic
// ============================================================
async function expAnthropic() {
  const url = anthropicUrl();
  if (!url) {
    console.log("\n[跳过 B] .env 没有 XIAOMI_ANTHROPIC_URL");
    return;
  }

  section("B. Anthropic 原生端点 /anthropic —— 第一跳：模型要调工具吗");
  // Anthropic 原生协议：system 是顶层参数、key 走 x-api-key 头、必须带 anthropic-version
  const body1 = {
    model: CFG.model,
    max_tokens: 1024,
    system: "你是一个严谨的助手。",
    messages: [{ role: "user", content: QUESTION }],
    tools: ANTHROPIC_TOOLS,
  };
  const raw1 = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CFG.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body1),
  });
  if (!raw1.ok) {
    console.log(`!! HTTP ${raw1.status}（可能 /anthropic 不支持 tools 参数）`);
    console.log((await raw1.text()).slice(0, 500));
    return;
  }
  const resp1 = await raw1.json();
  console.log(`stop_reason = ${resp1.stop_reason}`);
  console.log("content 原始形状（截断到 800 字符）:");
  console.log(JSON.stringify(resp1.content, null, 2).slice(0, 800));

  const toolUse = resp1.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    console.log("!! 没有 tool_use 块（模型直接回答了）");
    return;
  }
  console.log(`>> 要调: ${toolUse.name}  input=${JSON.stringify(toolUse.input)}  (类型: ${typeof toolUse.input})`);

  section("B. 第二跳：执行工具，把结果回传");
  // Anthropic 的回传规矩：assistant 全部 content 原样回填；
  // tool_result 放在下一条 **user** 消息的块数组里（不是独立的 tool role！）
  const result = { time: TIME() };
  console.log(`>> 执行 ${toolUse.name}() → ${JSON.stringify(result)}`);
  const body2 = {
    ...body1,
    messages: [
      { role: "user", content: QUESTION },
      { role: "assistant", content: resp1.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) }],
      },
    ],
  };
  const raw2 = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CFG.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body2),
  });
  if (!raw2.ok) {
    console.log(`!! HTTP ${raw2.status}`);
    console.log((await raw2.text()).slice(0, 500));
    return;
  }
  const resp2 = await raw2.json();
  console.log(`stop_reason = ${resp2.stop_reason}`);
  const text = resp2.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`最终回答: ${text}`);
  if (resp2.usage) {
    console.log(`token: 输入 ${resp2.usage.input_tokens} / 输出 ${resp2.usage.output_tokens}`);
  }
}

// ============================================================
// 第三部分（补测）：Anthropic 端点回传时剥掉 thinking 块行不行？
// 背景：真 Anthropic API 开 thinking 时强制要求回传 thinking 块（含签名）；
// MiMo 返回的 thinking 块 signature 是空串。我们的中立格式原则是 reasoning
// 不回传——如果剥掉也能过，provider 映射就能保持干净；不能过就得特殊处理。
// ============================================================
async function expAnthropicStripThinking() {
  const url = anthropicUrl();
  if (!url) return;

  section("C. 补测：/anthropic 回传时剥掉 thinking 块行不行");
  const body1 = {
    model: CFG.model,
    max_tokens: 1024,
    messages: [{ role: "user", content: QUESTION }],
    tools: ANTHROPIC_TOOLS,
  };
  const raw1 = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CFG.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body1),
  });
  const resp1 = await raw1.json();
  const toolUse = resp1.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    console.log("!! 这轮模型没要工具，补测作废（可重跑）");
    return;
  }

  // 关键差异：assistant 只回传 tool_use 块，thinking 块被剥掉
  const stripped = resp1.content.filter((b) => b.type !== "thinking");
  console.log(`原始 content 有 ${resp1.content.length} 块，剥掉后剩 ${stripped.length} 块`);
  const raw2 = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CFG.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      ...body1,
      messages: [
        { role: "user", content: QUESTION },
        { role: "assistant", content: stripped },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify({ time: TIME() }) }] },
      ],
    }),
  });
  if (!raw2.ok) {
    console.log(`!! 结论：剥掉 thinking 后 HTTP ${raw2.status}，端点不接受`);
    console.log((await raw2.text()).slice(0, 400));
    return;
  }
  const resp2 = await raw2.json();
  const text = resp2.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(`结论：剥掉 thinking 也能过（stop_reason=${resp2.stop_reason}），回答: ${text.slice(0, 120)}`);
}

console.log(`通道: MiMo ${CFG.model}（key 已脱敏，安全规则见 ROADMAP）`);

// 用法：node exp-toolcall.mjs        全跑
//       node exp-toolcall.mjs c     只跑补测部分
const only = (process.argv[2] ?? "").toLowerCase();
if (!only || only === "a") await expOpenAI();
if (!only || only === "b") await expAnthropic();
if (!only || only === "c") await expAnthropicStripThinking();
console.log("\n实验结束。观察点回顾：arguments 是字符串还是对象？停止原因叫什么？结果回传挂在哪条消息上？");
