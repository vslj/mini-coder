# NOTES —— 博客素材主库

> 协作规则 4：三栏结构，随手记。这是博客系列的第一手素材库，来源必须是**真实使用/实验中亲眼所见**，不是转述文档。

## 一、使用观察（日常用 Claude Code / 各类 AI 编码工具时看到的现象）

- （M1 期间）上下文快满时出现压缩提示（compact），压缩后模型"忘掉"部分细节——**压缩是客户端在改 messages 数组**
- （M2/M3 期间）Claude Code 每次执行写文件、跑命令前弹权限确认，可选"本会话不再询问"——**确认发生在程序侧，模型无法绕过**
- （M4 期间）CLAUDE.md = 用户可自定义的 system prompt 素材：启动时被注入到 system prompt，最终生效的 = 内置指令（改不了）+ CLAUDE.md（用户层）+ 记忆；它仍是软约束，硬约束在程序侧（权限/hooks）——M4"软硬约束分工"的产品化实例
- （M5 期间）Skill = 按需加载的工作流说明书（软约束的加强版）；hooks = 挂在程序生命周期上的代码关卡（硬约束的正式形态）——"根本不经过模型"，prompt 注入也绕不过。三者的表格式对比见 M4/M5 学习对话
- （阶段0 验收实测）/clear 后模型对"暗号"一无所知——失忆的本质是客户端清空数组，亲手验证
- （阶段0 验收实测）同一会话把同一个问题问第二遍，模型的回答末尾冒出"你是在测试我吗？"——它"知道"自己被重复提问，因为每轮全量历史都在重发。**客户端持有会话**最直观的可见实证，博客①素材
- （阶段0 验收实测）断网重试曲线 1405/2022/4326ms，与 M5 学习时的 1114/2214/4388ms 同款公式；三次耗尽后干净报 `[provider 错误 network]`，进程不崩、提问撤回——结构化错误 + 退避在真实故障下端到端工作
- （阶段0 验收实测）几百字长中文流式回复无乱码无丢字（TextDecoder 行缓冲通过）。但"通过"的表现恰恰是看不见任何东西——为让跨 chunk 边界可观测，加 MINICODER_DEBUG=chunks 调试开关（stderr 打原始 chunk，预览切在中文中间出现 � 就是流式解码必要性的现场演示）
- （阶段0 验收实测）token 账单决定性一幕：anthropic 分支下新问题仅 ~10 token，输入计费却高达 2427——差额是全会话历史（含 500 字长回答）全量重发。**成本由历史长度驱动，与新输入几乎无关**，M5 成本曲线的现场复现。另：MiMo 的 Anthropic 流式回 usage（输出 149），OpenAI 流式全程不回——双分支 usage 可得性不对称，/usage 数字只在 anthropic 侧增长
- （阶段1 实验①，learning/p1/）双端点工具调用对照一手实测：OpenAI 侧 arguments 是 **JSON 字符串**要自己 parse、停止原因 `tool_calls`、结果挂独立 `role:"tool"` 消息；Anthropic 侧 input 直接是 **JSON 对象**、停止原因 `tool_use`、结果要塞进下一条 user 消息的 `tool_result` 块。同一件事三种写法——provider 抽象层必要性的第二章
- （阶段1 实验①）MiMo Anthropic 端点返回的 `thinking` 块 **signature 是空字符串**，且剥掉 thinking 块再回传端点照常接受——真 Anthropic 开 thinking 时强制回传带签名的 thinking 块，仿制端点的宽容度是"不能依赖宽容"的又一证据（同 DeepSeek 忽略 reasoning_content 的前科）
- （阶段1 验收实测）agent 模式一轮任务里模型**并行要两个工具**（get_time + calculate 同轮），循环逐个执行逐条回传后模型汇总——"一次说话多个 tool_calls"是常态，回传必须逐条对号
- （阶段1 验收实测）非流式下双协议 usage 都有账（agent 模式 /usage 正常增长），与阶段 0 流式下 OpenAI 侧无账形成对照——**账目可得性跟着"流式与否"走，不跟着协议走**
- （阶段1 验收实测）/tools off 切回纯聊天流式，打字机与 [思考] 显示零回归——两种模式共享同一份 messages 历史，"模式"只是循环形状不同，会话状态是同一个
- （阶段1 用户实测，意外发现）同一会话先跑过 agent 模式再 /tools off，模型把工具调用"演"成正文输出（`<tool_call><function=...>` 格式的纯文本，无 ⚙ 执行行）——①本轮没声明工具，历史里的 tool_calls 往返仍在诱导模型模仿该格式，**能力靠 schema 声明激活，但模仿历史是默认习性**；②演出来的调用只是文字永远不会被执行，**客户端是唯一执行者**（M4 软硬约束分工的又一实证）；③输出的恰好是 MiMo 内部聊天模板原始语法 `<tool_call><function=get_time>`——正常用户看不到的模板内层被"诈"出来了
- （阶段1 用户实测）多步任务依赖链实证："先算 12*88，再算结果除以 33"——第二次 calculate 的参数是 1056/33，数字来自第一个工具结果。**"看结果→再想"是循环存在的理由**，单轮工具调用撑不起多步任务
- （阶段2 验收实测）**模型自发"执行后自检"**：每次 write_file/edit_file 成功后都主动 read_file 复查一遍再汇报——ROADMAP 阶段 3 的 verify work 主题没教就自己冒出来了，"先分析后动手、执行后自检"是模型在合适工具面前的自然倾向
- （阶段2 验收实测）权限拒绝喂回后，模型一句辩解都没有，直接说"操作被拒绝了，文件没有被创建，需要时随时找我"——拒绝消息里写明"不要原样重试"的引导 + system prompt 的配合，模型行为立刻收敛。**错误消息的措辞是行为设计的杠杆**
- （阶段2 验收实测）`../说明.md` 越界报错喂回后，模型自己推断出"工作区根目录下就有一个 说明.md，需要我读这个吗？"——错误喂回的价值不只是"知道了失败"，模型会从错误信息里推断出路
- （阶段2 验收实测）.env 敏感文件闸拒绝后，模型主动建议读 .env.example——**拒绝消息里给出替代路径，模型就把出路接住了**；安全设计不是一堵墙，是一堵带指示牌的墙
- （阶段2 验收实测）一个会话六个任务的 token 账：输入累计 43737——文件内容（read 结果、diff 预览）进历史后，历史膨胀速度比纯聊天陡峭得多，阶段 4 上下文管理的伏笔
- （阶段2 用户实测，**暴露设计缺陷并修正**）agent 回合被 Ctrl+C 中断后整回合从历史消失，用户追问"你没看到么？"时模型诚实回答没见过这个提问——v0.3 的全量回滚与阶段 0"中断不丢上下文"哲学冲突。复盘发现 Ctrl+C 只能打断 provider 网络调用，而打断时刻的历史恰好总是协议合法的 → 修正为：真错误才回滚，用户中断保留进度，"继续"能接上（附带的连续 user 消息问题在 anthropic provider 合并解决）
- （阶段2 用户实测）权限拒绝后模型不重试也不解释，反问"请问你希望写入什么内容呢？"——拒绝消息 + 引导措辞让"拒绝"变成对话的一步而不是任务的终点
- （阶段2 用户实测）被问"刚才咱们在干什么"而历史里没有线索时，模型自发 list_files + read README/NOTES/LEARNING 找上下文——agentic search（让模型自己翻文件）在没有任何指示下的自然涌现，与 M6 调研的 Anthropic 剖析文相互印证
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
- （阶段0）Windows + readline 的 Ctrl+C 隐蔽机制：readline 创建后终端进入生模式（raw mode），Ctrl+C 不再是进程级 SIGINT，而是 `\x03` 字符由 readline 解释成 rl 自己的 SIGINT 事件。若流式期间只 `rl.pause()` 不切模式，`\x03` 滞留在输入缓冲区——表现为"Ctrl+C 没反应，多按几次后突然退出"（积压的 ^C 在回到提示符后迟到爆发）。修法：pause 期间 `process.stdin.setRawMode(false)` 切回熟模式让 ^C 恢复为进程信号，resume 时再切回来
- （阶段0）中断语义的实证：流式中断时把半截回答带 `[回答被用户中断]` 标注入历史，模型下一轮能精确说出自己断在哪一行——"中断不丢上下文"比"中断即丢弃"对 agent 场景更有价值（用户实测通过：JS 链表示例答到一半被中断，模型准确复述断点并主动提出续写）
- （阶段1）MiMo Anthropic 端点的 tool_use 块 id 前缀是 `call_...`（OpenAI 风格），官方 Anthropic 是 `toolu_` 前缀——仿制端点内部大概是同一套实现两个皮，协议方言又添一证（对号逻辑不能依赖 id 格式，只当不透明字符串用）
- （阶段1）管道喂 REPL 的坑再确认：Windows readline 对"一次性到齐的管道输入"只交付给 pending 中的 question，后续行在流式/LLM 调用期间到达就丢（阶段 0 已记，今天换 pnpm exec 直连再踩一次）。自动化验收必须逐行喂+sleep 间隔
- （阶段1）calculate 演示工具的白名单教训写进代码注释：`new Function` 求值前必须先过字符白名单正则——"先校验后执行"是阶段 2 文件工具路径白名单的预演
- （阶段2）路径越界检查必须在 `resolve()` **之后**做（比较解析后的绝对路径是否仍以工作区根开头），在拼接前用字符串检查挡不住 `../` 和绝对路径注入
- （阶段2）Windows 文本文件的 CRLF 现实：不把读入内容归一成 LF，模型给的 old_string（\n）永远匹配不上 CRLF 文件——edit 工具在 Windows 上会"永远找不到要替换的文本"。读入归一、写出统一 LF
- （阶段2）权限确认弹窗的 Ctrl+C 语义：熟模式下 ^C 是进程级 SIGINT，与挂起中的 readline question 没有通信通道——用 `rl.write("n\n")` 模拟用户敲 n 让确认按"拒绝"结算，绕开和 readline 内部状态的搏斗
- （阶段2）重复注册 SIGINT 处理器的坑：新旧两个处理器都会跑，旧处理器在确认弹窗期间会 `abort()` 掉整个 agent 回合——接新语义时要把旧处理器一并收编，不能只加不减
- （阶段2）管道脚测的定时竞态：确认提示响应后，测试脚本多余的按键会落回主提示符变成"幽灵任务"（本次验收出现一次幽灵轮：模型收到孤立的 y 跑去 list_files）——脚本化确认要么掐准时机，要么接受幽灵轮的噪声
- （阶段2）朴素 LCS diff 的 O(n×m) 内存：先掐公共前后缀再 DP、中间段超 400 行降级整段替换——实测 3000 行文件改 1 行，前后缀掐完后 DP 规模退化到 1×1，降级路径根本没走到（真实编辑大多如此）
- （阶段2 修正）中断保留进度会产生连续 user 消息（没答完的提问 + 新提问、工具结果块 + 新文本），Anthropic 协议要求严格交替——在 anthropic provider 内合并（text 块追加在 tool_result 块后，MiMo 真端点实测 200 接受）。协议差异照例吸收进 provider，中立格式与 agent 循环都不用动

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
