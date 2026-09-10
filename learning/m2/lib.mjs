// lib.mjs —— M2 三个实验共用的小工具库
// 注意：这是"教学代码"，刻意不抽象过度，每个函数都短到能一眼看完。
//
// 实验通道：小米 MiMo 开放平台（OpenAI 兼容协议）
// 配置全部放仓库根目录 .env（已 gitignore）：XIAOMI_KEY / XIAOMI_OPENAI_URL / XIAOMI_MODEL

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------- 从 .env / 环境变量读配置 ----------
// 环境变量优先，.env 兜底；安全规则（ROADMAP 协作规则 2）：
// key 绝不打印原文，任何输出/文档里一律写 sk-xxx。
function loadEnv() {
  const cfg = {
    key: process.env.XIAOMI_KEY,
    openaiUrl: process.env.XIAOMI_OPENAI_URL,
    model: process.env.XIAOMI_MODEL,
  };

  const envPath = join(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, name, value] = m;
      const v = value.replace(/^["']|["']$/g, ""); // 去掉可能的引号
      if (name === "XIAOMI_KEY" && !cfg.key) cfg.key = v;
      if (name === "XIAOMI_OPENAI_URL" && !cfg.openaiUrl) cfg.openaiUrl = v;
      if (name === "XIAOMI_MODEL" && !cfg.model) cfg.model = v;
    }
  }

  const missing = [];
  if (!cfg.key) missing.push("XIAOMI_KEY");
  if (!cfg.openaiUrl) missing.push("XIAOMI_OPENAI_URL");
  if (!cfg.model) missing.push("XIAOMI_MODEL");
  if (missing.length > 0) {
    console.error(`[错误] .env 缺少配置: ${missing.join(", ")}`);
    console.error("  .env 应包含（已 gitignore，不会进 git）：");
    console.error("  XIAOMI_KEY=sk-你的key");
    console.error("  XIAOMI_OPENAI_URL=https://api.xiaomimimo.com/v1");
    console.error("  XIAOMI_MODEL=mimo-v2.5-pro");
    process.exit(1);
  }
  return cfg;
}

// 模块加载时读一次，三个实验脚本共用
export const CFG = loadEnv();

/**
 * 发一次 /chat/completions 请求（非流式），返回解析好的响应 JSON。
 * 故意不用任何 SDK——实验目的就是看协议本身长什么样。
 */
export async function chat(messages, extra = {}) {
  const body = { model: CFG.model, messages, ...extra };
  const resp = await fetch(`${CFG.openaiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CFG.key}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errText}`);
  }
  return resp.json();
}

/** 打印带标题的分隔块，让实验输出像一份"实验记录"而不是日志。 */
export function section(title) {
  console.log(`\n${"=".repeat(62)}\n【${title}】\n${"=".repeat(62)}`);
}

export const MODEL_NAME = CFG.model;
