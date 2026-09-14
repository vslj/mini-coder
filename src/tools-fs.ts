/**
 * tools-fs.ts —— 四个真实文件工具：read_file / list_files / write_file / edit_file。
 *
 * 安全设计三件套（阶段 2 的核心教学内容）：
 *
 *  1. 路径逃逸防护：所有路径先 resolve 成绝对路径，再检查是否仍在工作区内。
 *     在 resolve 之后检查（而不是字符串拼接前）是关键——"../../.env"、
 *     绝对路径注入这类花招在解析后都会现出原形。M3 实验里"没有防 ../ 逃逸"
 *     欠下的债在这里还清。
 *  2. 读类放行、写类确认：read/list 不设 needsApproval（读工作区是 agent 的
 *     基本权利）；write/edit 设 needsApproval，执行前由权限门拦截，
 *     预览用 diff.ts 画的行级差异。
 *  3. 错误脱敏在 ToolRegistry 层统一做（tools.ts 的 maskPaths），
 *     这一层只管把错误抛出来——抛错 = 把错误喂回模型让它自己调整（自愈）。
 *
 * Windows 现实：文本统一按 LF 处理（读入时把 CRLF 归一成 LF，写出用 LF）。
 * 不归一的话，模型给出的 old_string（\n）永远匹配不上 CRLF 文件，
 * edit 工具在 Windows 上会"永远找不到要替换的文本"。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Tool } from "./tools.js";
import { lineDiff, renderDiff } from "./diff.js";

/** read_file 单次最多读多少行（防止大文件塞爆上下文——上下文管理是阶段 4 的主题）。 */
const READ_MAX_LINES = 400;

/**
 * 把用户/模型给的相对路径安全地解析到工作区内。
 * 越界（解析后不在 root 里）直接抛错——错误会被喂回模型。
 */
function resolveSafe(root: string, path: string): string {
  const target = resolve(root, path);
  const rootAbs = resolve(root);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`路径越界：只能操作工作区内的文件（${relative(rootAbs, target) ?? path} 不在工作区内）`);
  }
  return target;
}

/** 读文本 + CRLF 归一。所有读文件的地方都走这里。 */
function readText(absPath: string): string {
  return readFileSync(absPath, "utf8").replace(/\r\n/g, "\n");
}

/**
 * 敏感文件闸：.env 一类密钥文件连读都不许——
 * 读类工具虽然默认放行，但把 key 读进上下文就等于把密钥送给了模型（还会随
 * 下一轮请求原样发出去），违反本项目的密钥安全规则（ROADMAP 协作规则 2）。
 * "读操作无害"的默认在这里划出例外。
 */
function assertNotSensitive(root: string, absPath: string): void {
  const name = absPath.split(sep).pop() ?? "";
  if (/^\.env/.test(name)) {
    throw new Error(`${displayPath(root, absPath)} 是敏感文件（可能含密钥），mini-coder 拒绝读写它`);
  }
}

/** 工作区内显示用的相对路径（错误信息和结果里都用它，不泄漏绝对路径）。 */
function displayPath(root: string, absPath: string): string {
  return relative(resolve(root), absPath).replaceAll("\\", "/") || ".";
}

export function createFsTools(root: string): Tool[] {
  // ---------- read_file：读类，放行 ----------
  const readFile: Tool = {
    name: "read_file",
    description: `读取工作区内某个文本文件的内容（最多前 ${READ_MAX_LINES} 行，超出会截断标注）。`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径，例如 src/cli.ts" },
      },
      required: ["path"],
    },
    run(args) {
      const abs = resolveSafe(root, String(args.path ?? ""));
      assertNotSensitive(root, abs);
      const stat = statSync(abs);
      if (stat.isDirectory()) throw new Error(`${displayPath(root, abs)} 是目录，读文件请用 read_file 指向具体文件`);
      const all = readText(abs).split("\n");
      const truncated = all.length > READ_MAX_LINES;
      return {
        path: displayPath(root, abs),
        total_lines: all.length,
        truncated,
        content: truncated ? all.slice(0, READ_MAX_LINES).join("\n") : all.join("\n"),
      };
    },
  };

  // ---------- list_files：读类，放行 ----------
  const listFiles: Tool = {
    name: "list_files",
    description: "列出工作区内某个目录的内容（单层，子目录用 / 结尾标注）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录的相对路径，缺省为工作区根" },
      },
    },
    run(args) {
      const abs = resolveSafe(root, String(args.path ?? "") || ".");
      if (!statSync(abs).isDirectory()) throw new Error(`${displayPath(root, abs)} 不是目录`);
      const entries = readdirSync(abs)
        .map((name) => (statSync(join(abs, name)).isDirectory() ? `${name}/` : name))
        .sort((x, y) => (y.endsWith("/") ? 1 : 0) - (x.endsWith("/") ? 1 : 0) || x.localeCompare(y));
      return { path: displayPath(root, abs), entries };
    },
  };

  // ---------- write_file：写类，要确认，预览是行级 diff ----------
  const writeFile: Tool = {
    name: "write_file",
    description: "把文本内容写入工作区内的某个文件（覆盖式写入；父目录不存在会自动创建）。",
    needsApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
    preview(args) {
      const abs = resolveSafe(root, String(args.path ?? ""));
      assertNotSensitive(root, abs);
      const content = String(args.content ?? "");
      if (!existsSync(abs)) {
        const lines = content.split("\n").length;
        return `【新文件】${displayPath(root, abs)}（${lines} 行）\n${truncatePreview(content)}`;
      }
      return renderDiff(lineDiff(readText(abs), content));
    },
    run(args) {
      const abs = resolveSafe(root, String(args.path ?? ""));
      assertNotSensitive(root, abs);
      const content = String(args.content ?? "");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return { ok: true, path: displayPath(root, abs), bytes: Buffer.byteLength(content, "utf8") };
    },
  };

  // ---------- edit_file：写类，要确认，old/new 精确替换 ----------
  const editFile: Tool = {
    name: "edit_file",
    description:
      "编辑工作区内的某个文本文件：把 old_string 精确替换成 new_string。old_string 必须在文件中恰好出现一次，找不到或多处匹配都会报错。",
    needsApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
        old_string: { type: "string", description: "要被替换的原文（必须与文件内容逐字一致，含缩进）" },
        new_string: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "old_string", "new_string"],
    },
    preview(args) {
      // 预览走同一条替换逻辑：替换不了（找不到/多处匹配）就让人在弹窗里直接看到原因
      const { newContent } = applyEdit(root, args);
      const abs = resolveSafe(root, String(args.path ?? ""));
      return renderDiff(lineDiff(readText(abs), newContent));
    },
    run(args) {
      const { abs, newContent } = applyEdit(root, args);
      writeFileSync(abs, newContent, "utf8");
      return { ok: true, path: displayPath(root, abs) };
    },
  };

  /** edit 的替换逻辑：预览与 run 共用，保证"给你看的"和"实际做的"是同一件事。 */
  function applyEdit(rootDir: string, args: Record<string, unknown>): { abs: string; newContent: string } {
    const abs = resolveSafe(rootDir, String(args.path ?? ""));
    assertNotSensitive(rootDir, abs);
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    if (!oldString) throw new Error("old_string 不能为空");
    const content = readText(abs); // 文件不存在时这里抛 ENOENT，错误自然喂回模型
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      throw new Error(`找不到要替换的文本（可能与文件内容有细微差异，先 read_file 核对原文）`);
    }
    if (count > 1) {
      throw new Error(`old_string 出现了 ${count} 次——请扩大上下文让它唯一，或改用 write_file 整体重写`);
    }
    return { abs, newContent: content.replace(oldString, newString) };
  }

  return [readFile, listFiles, writeFile, editFile];
}

/** 新文件预览的兜底截断：模型偶尔想写入超长内容，弹窗不能刷满屏。 */
function truncatePreview(content: string, maxLines = 15): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return [...lines.slice(0, maxLines), `……（共 ${lines.length} 行）`].join("\n");
}
