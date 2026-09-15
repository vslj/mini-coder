# mini-coder

仿写极简版 Claude Code 的学习项目：**不依赖任何 SDK / 框架**，从裸 HTTP 请求开始，把 LLM API、流式、provider 抽象、Agent 循环逐层亲手写一遍。配套系列博客（亲身实践 → 原理 → mini 实现）。

当前进度：**阶段 3（反思与计划）** —— `/plan` 计划模式（只读侦察 → 计划批准 → 全量工具执行，"先计划再动手"由程序侧硬约束保障）+ 轮数上限校准。此前：阶段 2 文件工具 + 安全（read/write/list/edit、路径逃逸防护、敏感文件闸、y/n/a 权限确认带 diff 预览）；阶段 1 工具框架 + agent 主循环（`/tools` 切换 agent/纯聊天模式）。

## 运行

```bash
pnpm install
cp .env.example .env   # 填入你的 key 与端点（.env 已 gitignore）
pnpm dev               # 开发运行（tsx 免编译）
```

REPL 内命令：`/help` `/exit` `/clear` `/usage` `/provider [openai|anthropic]` `/tools [on|off]` `/plan <任务>`

```bash
pnpm build && pnpm start   # 构建产物运行（tsc → dist/）
```

## 结构（阶段 2）

```
src/
├── cli.ts               # 入口装配
├── config.ts            # .env + 环境变量 → AppConfig（key 全程脱敏）
├── types.ts             # 中立消息/工具格式 + Provider 接口（抽象层核心）
├── errors.ts            # ProviderError 结构化错误 + 指数退避重试
├── sse.ts               # 协议无关 SSE 行解析器
├── render.ts            # 流式终端渲染（暗淡思维链 → 正文）
├── repl.ts              # REPL 主循环（纯聊天流式 / agent 模式两种形态）
├── agent.ts             # agent 主循环（想 → 做 → 看结果 → 再想，回合原子性 + 轮数上限 + 权限门）
├── tools.ts             # 工具框架：注册表 + 执行器（错误脱敏后喂回模型自愈）
├── tools-demo.ts        # 阶段 1 演示工具（get_time / calculate）
├── tools-fs.ts          # 阶段 2 文件工具（read/write/list/edit + 逃逸防护 + 敏感文件闸）
├── permissions.ts       # 权限门：y/n/a 交互确认 + 会话记忆 + Ctrl+C=拒绝
├── diff.ts              # 自写最小行级 LCS diff（写操作预览）
└── providers/
    ├── index.ts         # 工厂
    ├── openai.ts        # OpenAI 兼容协议分支
    └── anthropic.ts     # Anthropic 原生协议分支
```

设计原则：零运行时依赖（LLM API 不需要 SDK）；教学代码标准，每份文件可对照博客逐行读懂；学习/实验过程沉淀见 [learning/](learning/) 与 [NOTES.md](NOTES.md)。
