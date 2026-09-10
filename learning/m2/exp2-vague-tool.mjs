// exp2-vague-tool.mjs —— 实验 2：description 的质量直接决定行为质量
//
// LEARNING.md M2 实验 2：故意描述一个模糊的工具，观察模型乱传参数。
// 做法是对照组实验：同一个问题，分别交给一个"说明书写得稀烂"的工具
// 和一个"说明书写得清楚"的工具，对比模型的参数质量。
//
// 运行：node exp2-vague-tool.mjs

import { chat, section, MODEL_NAME } from "./lib.mjs";

const QUESTION = "上海明天会下雨吗？";

// ---------- 对照组 A：说明书写得稀烂 ----------
// name 含义不明，description 只有四个字，参数叫 input 没有任何说明。
// 模型只能靠猜：input 里该放整句话？城市名？它每次猜的还可能不一样。
const vagueTool = [
  {
    type: "function",
    function: {
      name: "search",
      description: "搜索。",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
    },
  },
];

// ---------- 对照组 B：说明书写得清楚 ----------
// 同样的能力，但 name 见名知义、description 说了"什么时候用"，
// 每个参数都有类型 + 说明 + 示例。
const preciseTool = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市某一天的实际天气。当用户询问天气相关问题时使用。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名，例如：北京、上海" },
          date: { type: "string", description: "查询日期，例如：今天、明天、2026-09-11" },
        },
        required: ["city", "date"],
      },
    },
  },
];

async function run(label, tools) {
  section(`${label}：发给模型 tools + "${QUESTION}"`);
  const resp = await chat([{ role: "user", content: QUESTION }], { tools });
  const c = resp.choices[0];
  console.log(JSON.stringify(c, null, 2));
  console.log(`\n>> finish_reason = ${c.finish_reason}`);
  if (c.message.tool_calls) {
    for (const call of c.message.tool_calls) {
      console.log(`>> 模型调用 ${call.function.name}，参数原文：${call.function.arguments}`);
    }
  }
}

await run("对照组 A（模糊描述）", vagueTool);
await run("对照组 B（精确描述）", preciseTool);

section("对比要点（跑完后对照这里看）");
console.log("1. A 组的 arguments 长什么样？input 里塞的是什么？像不像'人话'而不是结构化参数？");
console.log("2. B 组的 arguments 是不是干净的 {city, date} 结构？");
console.log("3. 两次的差异只来自 description 里那几十个字——模型看不见工具的代码，");
console.log("   说明书就是它的全部世界。这就是'写好工具描述'是 Agent 工程核心工作的原因。");
