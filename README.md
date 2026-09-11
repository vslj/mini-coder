# mini-coder

仿写极简版 Claude Code 的学习项目：**不依赖任何 SDK / 框架**，从裸 HTTP 请求开始，把 LLM API、流式、provider 抽象、Agent 循环逐层亲手写一遍。配套系列博客（亲身实践 → 原理 → mini 实现）。

当前进度：**阶段 0（地基）** —— provider 抽象层（OpenAI 兼容 + Anthropic 原生双协议）+ SSE 流式 + 对话 REPL。

## 运行

```bash
pnpm install
cp .env.example .env   # 填入你的 key 与端点（.env 已 gitignore）
pnpm dev               # 开发运行（tsx 免编译）
```

REPL 内命令：`/help` `/exit` `/clear` `/usage` `/provider [openai|anthropic]`

```bash
pnpm build && pnpm start   # 构建产物运行（tsc → dist/）
```

## 结构（阶段 0）

```
src/
├── cli.ts               # 入口装配
├── config.ts            # .env + 环境变量 → AppConfig（key 全程脱敏）
├── types.ts             # 中立消息格式 + Provider 接口（抽象层核心）
├── errors.ts            # ProviderError 结构化错误 + 指数退避重试
├── sse.ts               # 协议无关 SSE 行解析器
├── render.ts            # 流式终端渲染（暗淡思维链 → 正文）
├── repl.ts              # REPL 主循环
└── providers/
    ├── index.ts         # 工厂
    ├── openai.ts        # OpenAI 兼容协议分支
    └── anthropic.ts     # Anthropic 原生协议分支
```

设计原则：零运行时依赖（LLM API 不需要 SDK）；教学代码标准，每份文件可对照博客逐行读懂；学习/实验过程沉淀见 [learning/](learning/) 与 [NOTES.md](NOTES.md)。
