/**
 * diff.ts —— 最小行级 diff：算出"哪些行删了、哪些行加了"，再渲染成人能读的预览。
 *
 * 为什么自己写而不是引依赖：零运行时依赖是本项目卖点（README），而
 * 行级 LCS diff 的核心只有几十行——被需求逼出来的原理，正是博客②想讲的。
 *
 * 算法（LCS，最长公共子序列）：
 *   diff 的本质是"保留尽量多的公共行"。dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度，
 *   回溯时相同就同走、不同就朝 LCS 更长的一侧走（删 a 行或加 b 行）。
 *
 * 工程底线：朴素 DP 是 O(n×m) 内存（两个 5000 行文件 = 2500 万格）。所以：
 *   1. 先掐掉公共前后缀——真实编辑通常只动中间一小段，DP 规模骤减；
 *   2. 中间剩余部分仍超限额（这里 400 行）就降级为"整段删除+整段新增"，
 *      不追求最优但绝不把内存吃爆。
 */

const DP_LIMIT = 400; // 中间段超过 400×400 格就降级（16 万格，几毫秒算完）

export type DiffLineType = "same" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // 1. 掐公共前后缀：头尾相同的行不进 DP，直接记为 same
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ type: "same" as const, text }));

  // 2. 中间段：小规模走 LCS，超限降级为整段替换
  if (midA.length <= DP_LIMIT && midB.length <= DP_LIMIT) {
    out.push(...lcsDiff(midA, midB));
  } else {
    for (const text of midA) out.push({ type: "del", text });
    for (const text of midB) out.push({ type: "add", text });
  }

  for (let i = endA; i < a.length; i++) out.push({ type: "same", text: a[i]! });
  return out;
}

/** 核心 LCS 回溯。只处理掐过前后缀的中间段，调用方保证规模受控。 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（倒着填表）
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // 正着回溯：相同 → same；不同 → 朝 LCS 更长的一侧走
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

// ---------- 渲染 ----------

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface RenderDiffOptions {
  /** 变更行上下各保留几行上下文（默认 2）。 */
  context?: number;
  /** 最多渲染多少行，超过折叠（防止一次预览刷满屏）。 */
  maxLines?: number;
}

/**
 * 把 DiffLine[] 渲染成带行号的预览：
 *   -  12 │ 被删的旧行（红）
 *   +  15 │ 新增的行（绿）
 *      13 │ 不变的上下文（行号 = 旧文件行号）
 * 长段不变的行折叠成 "…"（与真实 diff 工具同款行为）。
 */
export function renderDiff(lines: DiffLine[], opts: RenderDiffOptions = {}): string {
  const context = opts.context ?? 2;
  const maxLines = opts.maxLines ?? 60;

  // 标注行号并找出"值得展示"的范围：变更行 ± context
  let oldNo = 1;
  let newNo = 1;
  const numbered = lines.map((l) => {
    const entry = { ...l, oldNo: 0, newNo: 0 };
    if (l.type !== "add") entry.oldNo = oldNo++;
    if (l.type !== "del") entry.newNo = newNo++;
    return entry;
  });
  const changed = new Set<number>();
  numbered.forEach((l, idx) => {
    if (l.type !== "same") {
      for (let k = Math.max(0, idx - context); k <= Math.min(numbered.length - 1, idx + context); k++) {
        changed.add(k);
      }
    }
  });

  // 变更统计
  const delCount = lines.filter((l) => l.type === "del").length;
  const addCount = lines.filter((l) => l.type === "add").length;
  const head = `${DIM}(+${addCount} / -${delCount} 行)${RESET}`;
  const out: string[] = [head];

  let shown = 0;
  let prevShown = false;
  for (let idx = 0; idx < numbered.length; idx++) {
    if (!changed.has(idx)) {
      prevShown = false;
      continue;
    }
    if (shown >= maxLines) {
      out.push(`${DIM}  ……（预览已截断，共 ${numbered.length} 行变化区域）${RESET}`);
      break;
    }
    if (!prevShown && shown > 0) out.push(`  ${DIM}…${RESET}`);
    prevShown = true;
    shown++;
    const l = numbered[idx]!;
    if (l.type === "del") out.push(`${RED}- ${String(l.oldNo).padStart(4)} │ ${l.text}${RESET}`);
    else if (l.type === "add") out.push(`${GREEN}+ ${String(l.newNo).padStart(4)} │ ${l.text}${RESET}`);
    else out.push(`  ${String(l.oldNo).padStart(4)} │ ${l.text}`);
  }
  if (shown === 0) out.push("  （无变化）");
  return out.join("\n");
}
