/**
 * mini-coder 入口：装配 config → 创建 providers → 启动 REPL。
 * cli 只做粘合（<40 行），所有逻辑在下面的模块里。
 */
import { loadConfig, maskKey } from "./config.js";
import { createAllProviders } from "./providers/index.js";
import { startRepl } from "./repl.js";

try {
  const cfg = loadConfig();
  // 启动横幅：配置清单里的 key 一律脱敏展示
  console.log("mini-coder v0.1.0");
  console.log(`  模型      ${cfg.model}`);
  console.log(`  OpenAI    ${cfg.openaiUrl}`);
  console.log(`  Anthropic ${cfg.anthropicUrl}`);
  console.log(`  密钥      ${maskKey(cfg.key)}`);

  await startRepl({ providers: createAllProviders(cfg), initial: "openai" });
} catch (e) {
  console.error(`[错误] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
