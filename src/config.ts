/**
 * config.ts —— 把 .env + 环境变量读成一个带类型的 AppConfig。
 *
 * 语义沿用 learning/m2/lib.mjs 的 loadEnv：
 *   环境变量优先，.env 兜底；缺项报错并打印期望格式示例。
 *
 * 安全规则（ROADMAP 协作规则 2）：
 *   key 绝不打印原文，任何输出/文档/日志里一律写 sk-xxx。
 *
 * 与原型的差异：仓库根不再用"模块相对层级"算（src/ 与 dist/ 深度不同，
 * 编译后就会找错地方），而是从当前模块一路向上找 package.json——
 * 开发（tsx src/cli.ts）和构建产物（node dist/cli.js）都适用。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 两个 provider 共用的配置；key 只在内存里流转，永不出口。 */
export interface AppConfig {
  key: string;
  openaiUrl: string;
  anthropicUrl: string;
  model: string;
}

/** 从模块位置向上找到仓库根（含 package.json 的目录）。 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      // 走到磁盘根还没找到：说明不在项目目录里跑的
      throw new Error("找不到仓库根（应存在 package.json），请在 mini-coder 项目目录内运行");
    }
    dir = parent;
  }
}

/** 解析 .env 一行：只认 `NAME=value`（NAME 大写字母+下划线），去掉可选引号。 */
function parseEnvLine(line: string): [name: string, value: string] | null {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  // 两个捕获组在 match 成功时必然存在，用 ! 向类型系统说明（正则里没有可选组）
  return [m[1]!, m[2]!.replace(/^["']|["']$/g, "")];
}

/** key 的对外展示形态：只露前缀和长度，绝不露真实字符。 */
export function maskKey(key: string): string {
  return `sk-xxx（共 ${key.length} 字符）`;
}

/** env 优先、.env 兜底；缺项抛错（由 cli 捕获后打印并退出）。 */
export function loadConfig(): AppConfig {
  const cfg = {
    key: process.env.XIAOMI_KEY,
    openaiUrl: process.env.XIAOMI_OPENAI_URL,
    anthropicUrl: process.env.XIAOMI_ANTHROPIC_URL,
    model: process.env.XIAOMI_MODEL,
  };

  const envPath = join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [name, value] = parsed;
      // 环境变量优先：.env 只填"还没有值"的项
      if (name === "XIAOMI_KEY" && !cfg.key) cfg.key = value;
      if (name === "XIAOMI_OPENAI_URL" && !cfg.openaiUrl) cfg.openaiUrl = value;
      if (name === "XIAOMI_ANTHROPIC_URL" && !cfg.anthropicUrl) cfg.anthropicUrl = value;
      if (name === "XIAOMI_MODEL" && !cfg.model) cfg.model = value;
    }
  }

  const missing = [
    !cfg.key && "XIAOMI_KEY",
    !cfg.openaiUrl && "XIAOMI_OPENAI_URL",
    !cfg.anthropicUrl && "XIAOMI_ANTHROPIC_URL",
    !cfg.model && "XIAOMI_MODEL",
  ].filter((x): x is string => typeof x === "string");
  if (missing.length > 0) {
    throw new Error(
      `.env 缺少配置: ${missing.join(", ")}\n` +
        `  .env 应包含（已 gitignore，不会进 git，参考 .env.example）：\n` +
        `  XIAOMI_KEY=sk-你的key\n` +
        `  XIAOMI_OPENAI_URL=https://api.xiaomimimo.com/v1\n` +
        `  XIAOMI_ANTHROPIC_URL=https://api.xiaomimimo.com/anthropic\n` +
        `  XIAOMI_MODEL=mimo-v2.5-pro`,
    );
  }

  // 上面的 missing 检查保证了四项都非空
  return cfg as AppConfig;
}
