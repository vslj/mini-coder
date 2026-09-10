// agent-hardened.mjs —— M5 实验 2：给裸 Agent 装上三道防线
//
// 在 agent.mjs 的骨架上加三件工程装备：
//   防线一  重试与指数退避——429/5xx/网络错误是常态，暂时性错误自动重试
//   防线二  工具分级与权限确认——只读放行 / 可写确认 / 危险警告确认（硬约束，程序侧执行）
//   防线三  Ctrl+C 优雅中断——暂停+存档，--resume 续跑（Agent 全部状态 = messages + 磁盘）
//
// 运行：
//   node agent-hardened.mjs "任务描述"          ← 正常跑（写/删操作会弹确认）
//   node agent-hardened.mjs --test-retry        ← 用一个打不通的地址观察退避重试
//   node agent-hardened.mjs                     ← --resume 续跑上次的存档
//   （任务跑着的时候按 Ctrl+C → 存档退出）

import { chat } from "../m2/lib.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const SANDBOX = join(HERE, "sandbox");
if (!existsSync(SANDBOX)) mkdirSync(SANDBOX);
const SAVE_PATH = join(HERE, "session-saved.json");

// ================= 防线一：重试与指数退避 =================
// 暂时性错误（限流 429、服务端 5xx、网络层失败）→ 退避后重试；
// 永久性错误（400 参数错、401 鉴权错）→ 重试没意义，直接抛。
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 3, label = "请求") {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const m = e.message.match(/^HTTP (\d+)/);
      const status = m ? Number(m[1]) : 0; // 0 = 网络层错误（DNS/超时/连接拒绝）
      const retryable = status === 0 || RETRYABLE_STATUS.includes(status);
      if (!retryable || attempt >= maxRetries) throw e;
      const wait = 1000 * 2 ** attempt + Math.random() * 500; // 1s→2s→4s… + 抖动
      console.log(`   [${label}失败] ${e.message.slice(0, 70)}`);
      console.log(`   [退避] ${(wait | 0)}ms 后进行第 ${attempt + 1}/${maxRetries} 次重试...`);
      await sleep(wait);
    }
  }
}

async function testRetry() {
  console.log("用打不通的地址演示退避（每次都失败，退避间隔应呈 1s→2s→4s 趋势 + 随机抖动）：\n");
  const t0 = Date.now();
  try {
    await withRetry(
      () =>
        fetch("https://api.invalid.invalid/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        }),
      3,
      "演示"
    );
  } catch (e) {
    console.log(`\n>> 重试 ${3} 次后放弃，共耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(">> 真实场景里，第 2、3 次重试往往就成功了——用户只感觉到'稍微慢了一点'。");
  }
}

// ================= 防线二：工具分级与权限确认 =================
// 硬约束在程序侧：确认弹窗、拒绝执行都是程序的行为，模型管不着。
const TOOL_POLICY = {
  read_file: "只读", // 自动放行
  write_file: "可写", // 需确认
  delete_file: "危险", // 需确认 + 警告
};

async function confirm(level, call) {
  const tag = level === "危险" ? "⚠️  危险操作" : "✏️  写操作";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (
    await rl.question(`\n${tag} [${TOOL_POLICY[call.function.name]}] ${call.function.name}(${call.function.arguments})\n   允许执行? [y/N] `)
  ).trim().toLowerCase();
  rl.close();
  return ans === "y";
}

// ================= 工具定义与执行（比 M3 多一个 delete_file）=================
const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取沙盒目录下某个文件的内容。",
      parameters: { type: "object", properties: { path: { type: "string", description: "文件名" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "把文本内容写入沙盒目录下的某个文件（覆盖式写入）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "文件名" }, content: { type: "string", description: "完整文本内容" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除沙盒目录下的某个文件。不可恢复，慎用。",
      parameters: { type: "object", properties: { path: { type: "string", description: "文件名" } }, required: ["path"] },
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
        return { ok: true, path: args.path };
      case "delete_file":
        rmSync(filePath);
        return { ok: true, deleted: args.path };
      default:
        return { error: `未知工具: ${call.function.name}` };
    }
  } catch (e) {
    return { error: e.message.replace(/D:\\[^'"]+/g, "<本地路径>") }; // M3 教训：错误先脱敏再回传
  }
}

// ================= 防线三：Ctrl+C = 暂停 + 存档 =================
let liveMessages = null; // 当前会话的 messages，Ctrl+C 时存档

process.on("SIGINT", () => {
  if (liveMessages) {
    writeFileSync(SAVE_PATH, JSON.stringify(liveMessages, null, 2));
    console.log(`\n\n[Ctrl+C] 会话已存档（${liveMessages.length} 条 messages）→ ${SAVE_PATH}`);
    console.log("[Ctrl+C] 运行 node agent-hardened.mjs --resume 可从中断处续跑");
  } else {
    console.log("\n[Ctrl+C] 退出");
  }
  process.exit(130);
});

// ================= 加固版主循环 =================
async function agentLoop(messages, maxIterations = 10) {
  liveMessages = messages; // 交给 SIGINT 处理器，随时可存档
  let totalIn = 0,
    totalOut = 0;

  for (let round = 1; round <= maxIterations; round++) {
    const resp = await withRetry(() => chat(messages, { tools }), 3, `第${round}轮`);
    const msg = resp.choices[0].message;
    totalIn += resp.usage.prompt_tokens;
    totalOut += resp.usage.completion_tokens;
    console.log(`---- 第 ${round} 轮 | messages=${messages.length} | finish=${resp.choices[0].finish_reason} | 累计 token ${totalIn}入/${totalOut}出 ----`);

    if (resp.choices[0].finish_reason !== "tool_calls") {
      console.log(`\n【最终回答】\n${msg.content}`);
      console.log(`\n共 ${round} 轮，token 总计: 输入 ${totalIn} / 输出 ${totalOut}（成本意识：输入大头是反复重发的历史）`);
      return;
    }

    messages.push({ role: "assistant", content: msg.content, tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      // 防线二在此生效：执行前查分级表，需要确认就弹窗，拒绝就把理由回传给模型
      const level = TOOL_POLICY[call.function.name] ?? "未知";
      if (level !== "只读") {
        const allowed = await confirm(level, call);
        if (!allowed) {
          console.log("   >> 用户拒绝执行");
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ error: "用户拒绝执行该操作。如需继续，请调整方案或询问用户。" }),
          });
          continue; // 这一轮的其他调用照常处理
        }
      }
      const result = executeTool(call);
      console.log(`   >> ${call.function.name}(${call.function.arguments}) → ${JSON.stringify(result)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  console.log(`\n[强制停止] 已达最大迭代 ${maxIterations}`);
}

// ================= 入口 =================
const args = process.argv.slice(2);
if (args.includes("--test-retry")) {
  await testRetry();
} else if (args.includes("--resume")) {
  if (!existsSync(SAVE_PATH)) {
    console.error("没有找到存档文件，先正常跑一次并按 Ctrl+C。");
    process.exit(1);
  }
  const saved = JSON.parse(readFileSync(SAVE_PATH, "utf8"));
  console.log(`已恢复存档会话（${saved.length} 条 messages），模型会根据历史自己接着干：\n`);
  await agentLoop(saved);
} else {
  const task = args[0];
  if (!task) {
    console.error('用法: node agent-hardened.mjs "任务描述" | --test-retry | --resume');
    process.exit(1);
  }
  await agentLoop([{ role: "user", content: task }]);
}
