/**
 * mini-coder 入口：装配 config → 创建 providers → 注册工具 → 启动 REPL。
 * cli 只做粘合（<40 行），所有逻辑在下面的模块里。
 */
import { loadConfig, maskKey } from "./config.js";
import { createAllProviders } from "./providers/index.js";
import { startRepl } from "./repl.js";
import { ToolRegistry } from "./tools.js";
import { calculateTool, getTimeTool } from "./tools-demo.js";

try {
  const cfg = loadConfig();
  // 启动横幅：配置清单里的 key 一律脱敏展示
  console.log("mini-coder v0.2.0");
  console.log(`  模型      ${cfg.model}`);
  console.log(`  OpenAI    ${cfg.openaiUrl}`);
  console.log(`  Anthropic ${cfg.anthropicUrl}`);
  console.log(`  密钥      ${maskKey(cfg.key)}`);

  // 阶段 1 的演示工具；阶段 2 换成真正的文件工具，框架不变
  const tools = new ToolRegistry();
  tools.register(getTimeTool);
  tools.register(calculateTool);

  await startRepl({
    providers: createAllProviders(cfg),
    initial: "openai",
    tools,
    system: "你是 mini-coder，一个运行在终端里的极简编码助手。回答用中文，简洁直接。",
  });
} catch (e) {
  console.error(`[错误] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
