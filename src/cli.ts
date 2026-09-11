/**
 * mini-coder 入口：装配 config → 创建 provider → 启动 REPL。
 * 阶段 0 的 cli 只做粘合，所有逻辑都在下面的模块里。
 */
import { loadConfig, maskKey } from "./config.js";

try {
  const cfg = loadConfig();
  // 启动横幅：配置清单里的 key 一律脱敏展示
  console.log("mini-coder v0.1.0");
  console.log(`  通道    ${cfg.model}`);
  console.log(`  OpenAI  ${cfg.openaiUrl}`);
  console.log(`  Anthropic ${cfg.anthropicUrl}`);
  console.log(`  密钥    ${maskKey(cfg.key)}`);
} catch (e) {
  console.error(`[错误] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
