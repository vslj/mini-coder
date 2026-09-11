# NOTES —— 博客素材主库

> 协作规则 4：三栏结构，随手记。这是博客系列的第一手素材库，来源必须是**真实使用/实验中亲眼所见**，不是转述文档。

## 一、使用观察（日常用 Claude Code / 各类 AI 编码工具时看到的现象）

- （M1 期间）上下文快满时出现压缩提示（compact），压缩后模型"忘掉"部分细节——**压缩是客户端在改 messages 数组**
- （M2/M3 期间）Claude Code 每次执行写文件、跑命令前弹权限确认，可选"本会话不再询问"——**确认发生在程序侧，模型无法绕过**
- （M4 期间）CLAUDE.md = 用户可自定义的 system prompt 素材：启动时被注入到 system prompt，最终生效的 = 内置指令（改不了）+ CLAUDE.md（用户层）+ 记忆；它仍是软约束，硬约束在程序侧（权限/hooks）——M4"软硬约束分工"的产品化实例
- （M5 期间）Skill = 按需加载的工作流说明书（软约束的加强版）；hooks = 挂在程序生命周期上的代码关卡（硬约束的正式形态）——"根本不经过模型"，prompt 注入也绕不过。三者的表格式对比见 M4/M5 学习对话
- （待记）……

## 二、踩坑记录（实验/开发中真实踩过的坑）

- 实验中把真实 API key 原文贴进对话 → 立刻作废重发。规则：key 只进 `.env`，展示一律 `sk-xxx`
- （M4）对比实验共用一个沙盒目录 → 上一次运行改写了文件，实验组读到的不是原始状态——**Agent 实验会污染自己，对比前要重置共享状态**
- （M4）跨运行比较 token 数被缓存状态和思维链长度污染（实验组输入 597 < 对照 724 却多了 system prompt）——token 只在请求体逐字节相同时才可比（M2 破案实验的推论）
- MiMo 的 usage 上报 `reasoning_tokens: 0`，但 message 里明明有 `reasoning_content` ——同平台自相矛盾，token 账不能只看一个字段
- 脚本里预写"判读结论"文案，数据出来后结论是错的——脚本只呈现数据，判读是人的工作
- 工具报错原文（含本机绝对路径）直接回传模型 → 本机环境信息泄漏进上下文，错误要先加工再回传
- （阶段0）裸 fetch 的网络错误是普通 `TypeError: fetch failed`，不带状态码——provider 层必须把它包装成结构化错误（kind=network），否则重试层识别不了（M5 靠正则抓字符串的债，正式版第一天就还）
- （阶段0）MiMo 不支持 `stream_options: {include_usage: true}`——流式响应全程无 usage，非流式正常（实测 256/218）。与"reasoning_tokens=0"前科同源：MiMo 的 usage 字段不能全信，流式场景干脆拿不到
- （阶段0）readline promises API 的管道模式坑：多行输入恰逢"没有 pending 的 question"（流式暂停中/LLM 调用中）到达时，部分行会被当作无监听者的 line 事件丢弃。交互 TTY 下用户看到提示符才输入，天然避开；但管道喂入/多行粘贴会触发。 推论：自动化测试 REPL 要逐行慢喂，且 stdin EOF 时 question 永不 settle → 必须挂 rl.on("close") 优雅退出，否则 Node 以 unsettled top-level await 警告退出（exit code 13）
- （阶段0）MiMo Anthropic 端点探测结论（2026-09-11，curl 一手验证）：path = `{ANTHROPIC_URL}/v1/messages`；鉴权 `x-api-key` 头直接可用；`anthropic-version` 头**不强制**（不带也 200，官方协议要求仍照发）；思维链以 `thinking` 块/`thinking_delta` 完整暴露
- （阶段0）MiMo Anthropic 方言两则：① thinking 块的位置流式与非流式**不一致**——流式里先于 text（index 0），非流式 JSON 里却排在 text 后面（解析不能依赖顺序，只认块类型）；② 流式 `message_start` 的 `usage.input_tokens=1` 不可信（非流式同请求是 65），真实 output_tokens 在 `message_delta` 里；`cache_read_input_tokens` 是独立字段且按 Anthropic 语义不含在 input_tokens 里（1+256≈OpenAI 口径的 prompt_tokens 257）
- （阶段0）Windows Git Bash 的 curl 用 `-d "{\"k\":...}"` 内联 JSON 会被引号转义搞坏（服务端报 Invalid JSON），走 `--data @file` 稳定

## 三、同类实现调研（M6，2026-09-10 晚，全部经一手验证）

> 调研方式说明：本环境 WebSearch 被拒（403）、部分域名不可达，改用 curl 抓页面（均 200）+ 从 PyPI 下载官方源码包直接读代码完成，无编造。

### 四个实现 + 一篇机制剖析

- **Amp《How to Build an Agent》**（ampcode.com/how-to-build-an-agent）：约 190 行 Go，3 个文件工具（read_file/list_files/edit_file），Anthropic 协议。核心论点 **"agent = an LLM, a loop, and enough tokens"**；工具出错带 `is_error` 喂回模型自愈。无重试/权限/压缩/流式
- **HuggingFace smolagents**（github.com/huggingface/smolagents）：agent 逻辑约 1000 行。核心理念 **"agents that think in code"**——模型的动作是一段 Python 而非 JSON 工具调用；沙箱执行（本地受限解释器/E2B/Docker）；max_steps=20，超限先发"总结请求"做最后抢救
- **mini-swe-agent**（github.com/SWE-agent/mini-swe-agent，Princeton SWE-agent 团队）：agent 类约 100 行。**"everything is bash"**——唯一工具是 bash，文本协议（\`\`\`bash 代码块）而非 function calling；用异常做控制流状态机；trajectory 逐轮落盘 + 逐次成本记账（SWE-bench 评测逼出来的工程细节）
- **Anthropic《Building agents with the Claude Agent SDK》**（anthropic.com/engineering/building-agents-with-the-claude-agent-sdk）：Claude Code 机制官方剖析。循环 = **gather context → take action → verify work → repeat**；agentic search（让模型自己 grep）通常优于语义检索，"文件系统就是 context engineering"；subagent 并行 + 上下文隔离；compaction 自动摘要
- HumanLayer 12-factor agents（humanlayer.dev/12-factor-agents，2026-09-11 已验证可达 200；内容未读，写博客前需读原文）

### 跨实现共同模式（≈ agent 的最小定义）

1. **同一个循环骨架**：`while 未结束: 调 LLM → 解析动作 → 执行 → 结果回填 messages`——四家无一例外
2. **客户端持有会话**：模型服务端无状态，每轮全量重发，上下文管理是共同暗坑
3. **终止两件套**：模型自答（无 tool_use / final_answer）或硬限额（max_steps/成本/时间）
4. **工具调用本质 = 特殊文本 → 本地解析执行 → 结果回填**；工具集都极小（3 个文件工具 / 1 个 bash）——殊途同归于"给模型一台计算机"
5. **错误喂回模型自愈，而非代码层重试**——四家都没有 API 级 retry/backoff

### 共同缺位（正好是博客"下一步"清单）

1. **权限/审批**：没有一家有逐操作确认或 allowlist——Claude Code 的 permission prompt 恰是"产品与玩具的分水岭"
2. **上下文压缩**：三家代码都是消息线性增长，只有 Anthropic 剖析文给出 compaction/subagent 隔离作为正式答案
3. **API 重试/退避、流式、断点恢复**：全部缺位
4. **Eval/轨迹回放**：只有 SWE-bench 团队做了——"评测需求才是工程能力的驱动力"
5. **沙箱是可选项不是默认**

> **对照 mini-coder 的有趣结论**：我们在 M5 已经做了其中三家都没有的东西（退避重试、权限分级确认、Ctrl+C 存档续跑、错误脱敏）——学习路线的选择恰好补在"最小实现"与"可用产品"的鸿沟上。
