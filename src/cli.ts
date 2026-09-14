/**
 * mini-coder 入口：装配 config → 创建 providers → 注册工具 → 启动 REPL。
 * cli 只做粘合（<40 行），所有逻辑在下面的模块里。
 */
import { loadConfig, maskKey } from "./config.js";
import { createAllProviders } from "./providers/index.js";
import { startRepl } from "./repl.js";
import { ToolRegistry } from "./tools.js";
import { calculateTool, getTimeTool } from "./tools-demo.js";
import { createFsTools } from "./tools-fs.js";

try {
  const cfg = loadConfig();
  // 启动横幅：配置清单里的 key 一律脱敏展示
  console.log("mini-coder v0.3.0");
  console.log(`  模型      ${cfg.model}`);
  console.log(`  OpenAI    ${cfg.openaiUrl}`);
  console.log(`  Anthropic ${cfg.anthropicUrl}`);
  console.log(`  密钥      ${maskKey(cfg.key)}`);
  console.log(`  工作区    ${process.cwd()}（文件工具的操作边界）`);

  // 阶段 1 的无害演示工具 + 阶段 2 的真实文件工具（写类带权限确认）
  const tools = new ToolRegistry();
  tools.register(getTimeTool);
  tools.register(calculateTool);
  for (const t of createFsTools(process.cwd())) tools.register(t);

  await startRepl({
    providers: createAllProviders(cfg),
    initial: "openai",
    tools,
    system:
      "你是 mini-coder，一个运行在终端里的极简编码助手。回答用中文，简洁直接。" +
      "你可以用工具读写当前工作区（工作目录）里的文件：先读再改，写操作会请用户确认，" +
      "操作被拒绝时不要原样重试，换方案或询问用户。",
  });
} catch (e) {
  console.error(`[错误] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
