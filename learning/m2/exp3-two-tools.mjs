// exp3-two-tools.mjs —— 实验 3：同时给两个工具，看模型怎么选
//
// LEARNING.md M2 实验 3。两问两答：
//   第一问需要两个工具都用上（时间 + 天数）→ 看它是"一次全调"还是"调一个等结果再调下一个"
//   第二问跟任何工具都无关 → 看它会不会忍住不调（工具多了"什么都要调"是真实风险）
//
// 运行：node exp3-two-tools.mjs

import { chat, section, MODEL_NAME } from "./lib.mjs";

// 两个互不重叠的工具：一个查时间，一个查天气
const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前的日期和时间（本地时区）。当用户问'现在几点'、'今天几号'等问题时使用。",
      parameters: { type: "object", properties: {} }, // 无参数
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市当前的实际天气。当用户询问天气相关问题时使用。",
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

// 本地假实现，与 exp1 同理：模型给什么参数，我们就"执行"什么
function executeTool(call) {
  const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  switch (call.function.name) {
    case "get_current_time":
      return { datetime: "2026-09-10 15:30 星期四" };
    case "get_weather":
      return { city: args.city, temperature: "22°C", condition: "晴" };
    default:
      return { error: `未知工具: ${call.function.name}` };
  }
}

// 跑完整流程（和 exp1 相同的两步请求结构），返回最终响应
async function fullRound(question) {
  const messages = [{ role: "user", content: question }];

  section(`第一问前奏："${question}"`);
  const resp1 = await chat(messages, { tools });
  const msg1 = resp1.choices[0].message;
  console.log(JSON.stringify(resp1.choices[0], null, 2));

  if (resp1.choices[0].finish_reason !== "tool_calls") {
    console.log("\n>> 模型没有调用任何工具，直接回答了。");
    return;
  }

  console.log(`\n>> 本轮模型要求调用 ${msg1.tool_calls.length} 个工具：`);
  for (const call of msg1.tool_calls) {
    console.log(`   - ${call.function.name}(${call.function.arguments})`);
  }

  // 原样回填 assistant 消息 + 每个 tool 结果一条 role:"tool" 消息
  messages.push({ role: "assistant", content: msg1.content, tool_calls: msg1.tool_calls });
  for (const call of msg1.tool_calls) {
    const result = executeTool(call);
    console.log(`>> 本地执行 ${call.function.name} → ${JSON.stringify(result)}`);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }

  const resp2 = await chat(messages);
  section(`最终回答（"${question}"）`);
  console.log(resp2.choices[0].message.content);
}

// 第一问：两个工具都用得上——重点看 tool_calls 数组里有几项
await fullRound("北京现在几点？天气适合出行吗？");

// 第二问：与任何工具无关——重点看模型会不会"手痒"
await fullRound("帮我写一句鼓励学习编程的话。");
