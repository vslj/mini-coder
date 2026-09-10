// exp1-weather-tool.mjs —— 实验 1：跑通工具调用完整两步请求
//
// 本实验要亲眼看到的事情（LEARNING.md M2 实验 1）：
//   请求带 tools → 模型返回 tool_use（它想调什么、参数是 JSON）→ 你的程序执行
//   → 把 tool_result 追加进 messages 再发 → 模型给出最终回答
//
// 核心事实：模型从不执行任何东西。它只"说"想调用 get_weather({"city":"北京"})，
// 真正执行的是下面 main() 里的那一行 switch。执行权永远在客户端。
//
// 运行：node exp1-weather-tool.mjs

import { chat, section, MODEL_NAME } from "./lib.mjs";

// ---------- 第 1 步：用 JSON Schema 定义工具 ----------
// 模型"决定"调用什么工具，靠的就是 name + description + 参数描述这些文字，
// 没有任何魔法。description 写得越清楚，模型用得越准（实验 2 会反证这一点）。
const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市当前的实际天气，包括温度、天气状况和湿度。当用户问到天气相关问题时使用。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名，例如：北京、上海" },
        },
        required: ["city"],
      },
    },
  },
];

// ---------- 第 2 步：本地"执行"工具的代码 ----------
// 这是假的：不查任何天气 API，返回固定值。模型不知道也不在乎——
// 它只管拿到 tool_result 里写的什么就信什么。这就是"执行权在客户端"。
function executeTool(call) {
  const args = JSON.parse(call.function.arguments); // arguments 是字符串！要自己 parse
  switch (call.function.name) {
    case "get_weather":
      return { city: args.city, temperature: "22°C", condition: "晴", humidity: "40%" };
    default:
      return { error: `未知工具: ${call.function.name}` }; // 防御：模型也可能"点菜"点出不存在的菜
  }
}

async function main() {
  const messages = [
    { role: "user", content: "北京今天天气怎么样？适合跑步吗？" },
  ];

  // ================= 第一次请求：把工具清单交给模型 =================
  section("第一次请求：messages + tools 发出去");
  console.log("此时 messages 长这样：");
  console.log(JSON.stringify(messages, null, 2));

  const resp1 = await chat(messages, { tools });
  const msg1 = resp1.choices[0].message;
  console.log(`>> 第一次请求完整 usage: ${JSON.stringify(resp1.usage)}`);

  section("第一次响应：finish_reason=tool_calls，模型只'说'不'做'");
  console.log(JSON.stringify(resp1.choices[0], null, 2));
  console.log(`\n>> finish_reason = ${resp1.choices[0].finish_reason}`);
  console.log(">> 注意：content 里可能有一句'我查一下'的话，也可能为 null；");
  console.log(">> 真正的调用意图全在 tool_calls 数组里，arguments 是一段 JSON 字符串。");

  if (resp1.choices[0].finish_reason !== "tool_calls") {
    console.log("\n[!] 模型没有要求调用工具（可能直接回答了）。响应全文：");
    console.log(JSON.stringify(resp1, null, 2));
    return;
  }

  // ================= 你的程序执行工具 =================
  section("本地执行：程序负责'做'");
  const results = [];
  for (const call of msg1.tool_calls) {
    console.log(`>> 模型想调用: ${call.function.name}`);
    console.log(`>> 参数(原始字符串): ${call.function.arguments}`);
    const result = executeTool(call);          // ← 执行权在这里！
    console.log(`>> 本地执行结果: ${JSON.stringify(result)}`);
    results.push({ call, result });
  }

  // ================= 第二次请求：把工具结果回传 =================
  // messages 现在要补两条：
  //   1. 原样追加模型的 assistant 消息（含 tool_calls）
  //      ——注意：DeepSeek 的 reasoning_content 不要回传（M1 已踩过这个坑）
  //   2. 每个工具结果一条 role:"tool" 消息，用 tool_call_id 对号入座
  messages.push({
    role: "assistant",
    content: msg1.content,
    tool_calls: msg1.tool_calls,
  });
  for (const { call, result } of results) {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result), // 工具结果也是文本，复杂对象要自己序列化
    });
  }

  section("第二次请求前的 messages（数组的演变全貌）");
  console.log(JSON.stringify(messages, null, 2));

  const resp2 = await chat(messages, { tools });
  section("第二次响应：finish_reason=stop，最终回答");
  console.log(JSON.stringify(resp2.choices[0], null, 2));
  console.log(`\n>> 第二次请求完整 usage: ${JSON.stringify(resp2.usage)}`);
}

main().catch((e) => {
  console.error("[实验失败]", e.message);
  process.exit(1);
});
