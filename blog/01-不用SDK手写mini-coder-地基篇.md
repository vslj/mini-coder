# 不用 SDK，手写一个 mini Claude Code（一）：地基——provider、流式与 REPL

> 这是 mini-coder 系列的第一篇。目标：**不依赖任何 SDK 和框架**，从裸 HTTP 请求开始，亲手写一个极简版 Claude Code。全部代码开源（v0.1 已打 tag），每篇博客对应一个阶段，代码按"教学标准"写成——你可以对照文章逐行读源码。
>
> 本文对应阶段 0：provider 抽象层、SSE 流式、对话 REPL。写代码之前的实验过程和原始数据都保留在仓库的 `learning/` 和 `NOTES.md` 里，文中引用的数字全部是一手实测，不是转述文档。

---

## 一、从一个"闹鬼"的瞬间说起

给自己的 REPL 做验收测试的时候，我在同一个会话里把同一个问题问了两遍（"9.11 和 9.9 哪个大？"）。第二次，模型的回答末尾多了一句话：

> 你是在测试我吗？哈哈，放心，答案不会变的～

那一瞬间很容易产生错觉：它记得我问过。

但紧接着的另一个实验戳破了这个幻觉。我在会话里先说了一个暗号，然后输入 `/clear`，再问"我的暗号是什么"——模型一无所知。同一台服务器、同一个模型，前面明明亲口确认过"好的，我记住了！"。

两个现象放在一起，答案就出来了：

- 它"记得"被重复提问，**不是因为模型有记忆，而是因为每一轮我都把完整历史重新发给了它**——历史里有上一遍的提问，它自然"知道"自己答过；
- `/clear` 之所以能"失忆"，只是因为**客户端清空了自己的 messages 数组**。

模型服务端是无状态的。所谓多轮对话，就是客户端拿着一个不断增长的数组，每次全量重发。**写一个 Claude Code，本质上就是在维护这个数组，再加上一个循环。**这是整个系列的地基认知，本文先把"数组"的供水管道修好：provider 层、流式、REPL。

---

## 二、先回到地面：LLM API 的三个事实

动手写代码之前，我花了一个周末用 curl 裸调 API（不用任何 SDK，就是为了看协议本身长什么样）。有三个事实值得先摆出来，后面所有的设计决策都从它们推出来。

### 事实一：记忆是你发的，且重发是要钱的

两轮对话实验。第一轮问"用一句话介绍你自己"，请求里只有一条 system 和一条 user，`usage.prompt_tokens` 是 **95**（其中人话只占 30 左右，剩下是协议开销）。第二轮追问"刚才你说了什么？"，我把第一轮的问答手动拼进 messages 再发出去，`prompt_tokens` 变成 **123**。

多出的 28 token，就是被重发的历史的价格。

这个数字看似温和，但它会滚雪球。下文有个 2427 的账单，先记住"重发不免费"这四个字。

### 事实二：一句话回答背后，可能拖着两倍长的草稿

还是那个"一句话介绍自己"的请求。回答正文 20 个字，但响应里除了 `content` 还有一个 `reasoning_content` 字段——模型打草稿的过程，比正文长得多。账单更诚实：`completion_tokens: 100`，其中 `reasoning_tokens: 80`。

**80% 的输出 token 花在了你看不见的思考上。**这也是后来 REPL 里我坚持把思维链渲染出来（暗淡色小字）的原因——你在等的那几秒，模型不是卡了，是在打草稿，你最好能看到它在打什么。

### 事实三：流式不是"打字机特效"，是另一种响应形态

请求体加一个 `"stream": true`，响应从"一个 JSON 对象"变成一条 SSE 流。裸眼看了一遍原始流之后，最有意思的发现是**两种 delta 的接力**：

```text
# 前面几十块全是 reasoning_content（草稿），content 一直是 null
data: {"choices":[{"delta":{"content":null,"reasoning_content":"我们需要"}}]}
data: {"choices":[{"delta":{"content":null,"reasoning_content":"回答"}}]}

# 转折点：草稿推完，content 开始出现
data: {"choices":[{"delta":{"content":"是的","reasoning_content":null}}]}

# 收尾：finish_reason 落定，然后一行字面量结束整个流
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

先草稿、后正文，泾渭分明。理解了这个接力，流式解析器该长什么样就不言自明了。

---

## 三、动手：四个构件

### 3.1 provider 抽象层：为"方言"而生

做完实验换实验通道（DeepSeek → 小米 MiMo）的时候，我第一次尝到 provider 差异的苦头。后来 MiMo 同时提供 OpenAI 兼容和 Anthropic 原生两个端点，我干脆把两种协议都实现了——差异清单变成了一份现成的对照表：

| 差异点 | OpenAI 兼容 | Anthropic 原生 |
|---|---|---|
| system 位置 | messages 数组第一条 | 顶层参数，不进数组 |
| max_tokens | 可选 | **必填**，协议没有默认值 |
| 鉴权 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` 头 |
| 思维链 | 厂商私有字段 `reasoning_content` | content 数组里的 `thinking` 块 |
| 停止原因 | `stop` / `length` | `end_turn` / `max_tokens` |
| 流式形态 | 纯 `data:` 行流 | `event:` + `data:` 成对的事件流 |

还有更隐蔽的。DeepSeek 的文档说 `reasoning_content` 不应回传给下一轮，但你带着回传也跑得通（服务端宽容忽略）——**依赖这种宽容，换一家就翻车**。MiMo 的方言更碎：思维链在流式响应里先于正文、在非流式 JSON 里却排在正文后面；流式开头的 `message_start` 里给的 `usage.input_tokens=1` 根本不可信（同请求非流式是 65）；`anthropic-version` 头不强制但官方协议要求。

面对这些，抽象层的设计就一个原则：**调用方只认识一套最小中立格式，所有方言差异在 provider 内部消化**。整个抽象核心就这么多：

```ts
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;   // 仅本轮展示用，入历史时只带 content
}

interface Provider {
  chat(messages, opts?): Promise<ChatResult>;              // 非流式
  chatStream(messages, onEvent, opts?): Promise<ChatResult>; // 流式
}
```

两个刻意的设计：

1. **system 不放进 messages 数组**，而是独立字段。OpenAI 把它当第一条消息、Anthropic 把它当顶层参数——两大协议分歧最大的地方，让它死在 provider 内部，调用方无感。
2. **`reasoning` 是可选项，而且历史回传时只取 `content`**。用类型系统把"思维链不回传"变成结构性约束，而不是注释里的一句提醒。

错误处理是抽象层的另一半。M5 做实验时写过一版重试逻辑，靠正则从 `Error("HTTP 429: ...")` 的错误消息里抓状态码——能用，但是"用字符串当数据结构"的债。正式版第一天就还掉：

```ts
class ProviderError extends Error {
  constructor(
    public readonly kind: "http" | "network" | "protocol",
    message: string,
    public readonly status?: number,   // kind === "http" 时必有
  ) { super(message); }
}
```

重试判定变成查字段：network 一律可重试；http 查白名单 `[429, 500, 502, 503, 504]`；protocol 是自己的解析 bug，重试没有意义。指数退避 `1s·2ⁿ + 随机抖动`，实测曲线 1405 → 2022 → 4326ms——断网的时候终端里能看到三次退避日志，第三次耗尽后干净地报一个结构化错误，进程不崩。

一个容易漏的点：裸 `fetch` 的网络错误是普通 `TypeError: fetch failed`，**不带任何状态信息**。provider 层必须负责把它包装成 `ProviderError("network")`，否则重试层根本认不出它是谁。

### 3.2 SSE 解析器：三个不踩不知道的坑

解析器刻意只做一件事：把字节流切成一条条完整的行，怎么解释这些行留给各 provider 分支。就 30 来行，但三个坑全是真实踩出来的：

**坑一：一条 `data:` 行可能跨 chunk 断开。**`data: {"id":"...长 JSON...` 在这个 chunk 结尾被切一半是常态，必须缓冲到凑齐换行符才能交出去。

**坑二：中文字符可能被切在两个 chunk 中间。**如果图省事对每个 chunk 直接 `toString()`，多字节 UTF-8 序列被拦腰切断就是乱码。必须用 `TextDecoder` 的流式模式——它会自动把不完整的字节序列留到下一个 chunk。为了让你能亲眼看见这件事，我在解析器里留了个调试开关：

```powershell
$env:MINICODER_DEBUG = "chunks"; node dist/cli.js
```

跑一个 500 字的长回答，stderr 会打出每个原始 chunk 的字节数和预览。你会看到 chunk 大小不一、成 burst 到达（网络从来不是匀速喂字的），还会偶尔看到预览里冒出 `�`——那正是 chunk 恰好切在汉字中间的现场。而真正的解码路径用了流式模式，所以正文永远干净。

**坑三：服务端会发 `:` 开头的注释行**（心跳/keepalive），不跳过它们解析就会炸。

### 3.3 终端渲染：正文透传，控制符只在状态切换时出现

渲染规则只有一条值得说：**正文 token 原样透传，绝不加工**。ANSI 色码只在两种 delta 接力的转折点输出——收到第一个 `reasoning` 事件时切暗淡色加 `[思考]` 前缀，从草稿切到正文时恢复颜色并空一行。效果就是你可以在终端里看着模型先"自言自语"再落笔，Claude Code 的同款体验，核心实现不到 40 行。

### 3.4 REPL：一个数组 + 一个 while 循环

REPL 的骨架朴素得可爱：`rl.question` 等输入 → 是内建命令就处理 → 否则把消息 push 进数组、调 `chatStream`、把回复 push 回数组。`/clear` 就是 `messages.length = 0`——上一节的"失忆实验"证明这四个字就够了。

值得展开的是 **Ctrl+C 的两态语义**，以及它在 Windows 上给我上的一课：

- 空闲时按 Ctrl+C → 退出；
- 流式中按 Ctrl+C → 中断当前请求、回到提示符，**进程不退**。而且已经有半截正文流出的话，那半截会带着 `[回答被用户中断]` 标注入历史——实测中断后问"我上一句回答到哪了"，模型能精确说出自己断在哪一行。

第一版实现跑起来后，Windows 上的现象是：流式中按 Ctrl+C 毫无反应，多按几次之后程序突然整个退出。排查半天，机制藏在终端的最底层：**readline 创建后会把终端切进"生模式"（raw mode），Ctrl+C 从此不再产生进程级信号，而是变成 `\x03` 字符交给 readline 解释**。而流式期间我调用了 `rl.pause()`，readline 不再读输入，`\x03` 就滞留在缓冲区里没人处理——直到你回到提示符，积压的按键一起爆发。

修法是在暂停期间把终端临时切回"熟模式"，让 Ctrl+C 恢复成真正的进程信号，走 `AbortController` 的中断管线（这个 signal 会从 REPL 一路穿透到 provider 内部的 fetch）：

```ts
rl.pause();
process.stdin.setRawMode?.(false);  // 切回熟模式：让 Ctrl+C 重新成为进程信号
// ... 流式请求与渲染 ...
process.stdin.setRawMode?.(true);   // 还原生模式：readline 的行编辑依赖它
rl.resume();
```

这类坑文档不会告诉你，只有亲手写一遍才会撞上。

---

## 四、验收账单：那个 2427

REPL 写完之后我给自己列了六项验收。前五项（中断、失忆、双协议对照、长中文、断网重试）都顺利，最后一项跑出了一个最有说服力的数字。

切到 Anthropic 分支后我问了个极短的问题："5.0 和 5.001 哪个大？"——十个字，撑死 10 个 token。回答完 `/usage` 一看：

```text
本会话累计 1 轮有账：输入 2427 + 输出 149 tokens
```

**输入 2427。**差额是整个会话的历史——包括之前那篇几百字的 SSE/WebSocket 长文、两遍 9.11。十个字的新问题几乎不影响账单，**成本由历史长度驱动**。

这就是"重发不免费"滚起来之后的形状，也是 Claude Code 为什么要在你上下文快满时主动 compact 的原因——不是模型嫌长，是你在为每一轮的全量重发付钱。上下文管理这条线，系列后面会专门展开。

顺带一个双分支的实测差异：MiMo 的 Anthropic 协议在流式里回 usage（那 149 就是它给的），OpenAI 兼容协议流式全程不给。所以我的 `/usage` 数字只在 anthropic 分支下增长——不算 bug，算方言。

---

## 五、下一步

阶段 0 的管道修完了：provider 双协议、SSE 流式、结构化错误与退避、REPL。但现在的它只会聊天——不会读文件、不会写文件、不会执行任何动作。

下一阶段是整个项目真正开始"像 Claude Code"的一步：**工具调用**。让模型说"我要读某个文件"，由程序执行后把结果喂回去，循环往复。届时 `finish_reason: "tool_calls"` 那个 M1 实验里的伏笔会正式登场。

项目地址与全部实验记录见仓库（代码注释全中文，欢迎对照阅读）。如果你也想体会一次"从裸 HTTP 到 Agent"的完整路径，建议别跳步骤——先花一个晚上用 curl 裸调一遍 API，你会对后面每一段代码都有体感。

---

*本系列的实验原始记录（含真实响应数据、key 脱敏）与踩坑笔记都在仓库 `learning/` 与 `NOTES.md`，本文所有数字可溯源。*
