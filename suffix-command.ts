/**
 * suffix-command —— 把输入按规则解析成 { input, cmd, args }，派发命令，草稿回填。
 *
 * 配置是一串规则，按顺序取第一条命中的（改完立即生效，每次回车都会重读）：
 *   ~/.pi/agent/suffix-command.json        全局
 *   <project>/.pi/suffix-command.json      项目（需项目信任）
 *
 *   {
 *     "rules": [
 *       { "trigger": "/btw" },                                          // command-first
 *       { "trigger": "/btw", "template": "command-first" },              // 同上，显式写
 *       { "trigger": "/q", "command": "/btw" },                         // 别名
 *       { "trigger": "/claro", "template": "command-mid" },            // 命令在句尾
 *       { "match": "(?<input>[\\s\\S]*?)\\s*##review\\s+(?<args>[^\\n]*)$",
 *         "command": "/subagent", "argsPrefix": "--agent reviewer" }
 *     ]
 *   }
 *
 * 一条规则：
 *   trigger    字面量触发词，带斜杠（`/btw`）或裸词（`btw`）都行
 *   template   切分模板，仅在 trigger 规则下生效：
 *                command-first（默认）命令在前：之前 = input，之后到行尾 = args
 *                command-mid        命令在尾：之前全部 = args，触发词必须在末尾
 *   match      自定义正则，作用于整段输入，可用命名组 input / args
 *   command    命中后派发的命令；省略时等于 trigger 本身（/btw -> /btw）
 *   argsPrefix 可选，拼在参数前面
 *
 * trigger 规则的语义：
 *   command-first（/btw 类）
 *     trigger 之前的内容 = input，回到输入框
 *     trigger 之后到行尾 = args，拼给命令
 *   command-mid（/claro 类）
 *     trigger 之前的内容 = args，拼给命令
 *     trigger 必须位于整段末尾，草稿清空
 *
 * 解析结果就是三个槽位：
 *   input  草稿 —— 回车后回填输入框
 *   cmd    命令 —— 规则里的 command
 *   args   参数 —— 拼在命令后面
 *
 * 不写配置文件时，任何已注册的 `/命令` 都能直接用（内置规则：每个已注册命令一条）。
 *
 * 命令：
 *   /suffix                  看当前规则和配置路径
 *   /suffix --test <示例输入>  看这段输入会被解析成什么、派发什么
 *   /suffix --init           生成配置文件（已存在则不覆盖）
 *   /suffix --edit           在外部编辑器里编辑配置，保存后立即生效
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "suffix-command.json";
const PROJECT_CONFIG_DIR = ".pi";
const STATUS_KEY = "suffix-command";
const COMMAND_NAME = "suffix";

/** 切分模板：命令在前（/btw）或命令在尾（/claro）。 */
type Template = "command-first" | "command-mid";

const TEMPLATES: readonly Template[] = ["command-first", "command-mid"];

/** 一条转化规则。 */
interface Rule {
  /** 字面量触发词，例如 `/btw` 或 `btw`。 */
  trigger?: string;
  /** 切分模板；省略时为 `command-first`。仅对 trigger 规则生效。 */
  template?: Template;
  /** 自定义正则（作用于整段输入），可用命名组 `input` / `args`。 */
  match?: string;
  /** 命中后派发的命令名（不含斜杠）。 */
  command: string;
  /** 追加在参数前面的固定参数，例如 `--agent reviewer`。 */
  argsPrefix?: string;
}

/** 解析结果：三个槽位。 */
interface Parsed {
  /** 草稿。 */
  input: string;
  /** 命令名（不含斜杠）。 */
  cmd: string;
  /** 参数。 */
  args?: string;
}

/** 编译后的规则。 */
interface CompiledRule {
  rule: Rule;
  regex: RegExp;
}

interface Evaluation {
  parsed: Parsed;
  /** 最终派发的完整命令，例如 `/subagent --agent reviewer 看下 diff`。 */
  command: string;
  /** 目标不可派发时的说明。 */
  error?: string;
}

/** 没有任何配置时的兜底规则：`/btw`。 */
const FALLBACK_RULE: Rule = { trigger: "/btw", command: "btw" };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 字面量触发词编译成正则，前边界：行首 / 空白 / 非 ASCII，后边界：空白或行尾。
 *
 *   command-first  key /btw 这类：
 *     前文 -> input（草稿），后文（同一行）-> args
 *   command-mid   /claro 这类：
 *     前文（可跨行）-> args，触发词必须落在整段末尾，input 为空
 */
function triggerPattern(trigger: string, template: Template = "command-first"): string {
  const head = `(?:^|(?<=\\s)|(?<=[^\\x00-\\x7F]))${escapeRegExp(trigger)}`;
  if (template === "command-mid") {
    return `(?<args>[\\s\\S]*?)${head}[ \\t]*$`;
  }
  return `${head}(?:[ \\t]+(?<args>[^\\r\\n]*?))?[ \\t]*(?=\\r?\\n|$)`;
}

function compileRule(rule: Rule): CompiledRule | undefined {
  const source = rule.match ? rule.match : rule.trigger ? triggerPattern(rule.trigger, rule.template) : "";
  if (!source) return undefined;
  try {
    return { rule, regex: new RegExp(source) };
  } catch {
    return undefined;
  }
}

/**
 * 整理草稿：只做两件事 —— 去掉行尾的 CR（换行符的一部分），
 * 去掉首尾的空行。空格、缩进、行内空白一律原样保留。
 */
function normalizeDraft(text: string): string {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/** 匹配区域之外的文本拼回草稿：前面的 + 后面的，必要时补一个换行。 */
function joinOutside(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const after = text.slice(end).replace(/^\r?\n/, "");
  if (before === "" || after === "") return before + after;
  if (before.endsWith("\n")) return before + after;
  return `${before}\n${after}`;
}

/** 用编译好的规则解析整段输入，得到三个槽位。 */
function parseWith(compiled: CompiledRule, text: string): Parsed | undefined {
  const match = compiled.regex.exec(text);
  const groups = match?.groups ?? {};
  if (!match) return undefined;

  const args = groups.args?.trim() || undefined;
  const input =
    typeof groups.input === "string"
      ? normalizeDraft(groups.input)
      : normalizeDraft(joinOutside(text, match.index, match.index + match[0].length));

  return { input, cmd: compiled.rule.command, args };
}

function normaliseRule(value: unknown): Rule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as {
    trigger?: unknown;
    template?: unknown;
    match?: unknown;
    command?: unknown;
    argsPrefix?: unknown;
  };

  const trigger = typeof raw.trigger === "string" && raw.trigger.trim() ? raw.trigger.trim() : undefined;
  const match = typeof raw.match === "string" && raw.match.trim() ? raw.match.trim() : undefined;
  if (!trigger && !match) return undefined;

  // template 只认白名单，写错视为无效规则（会在 /suffix 里提示）。
  const rawTemplate = typeof raw.template === "string" ? raw.template.trim() : "";
  if (rawTemplate && !(TEMPLATES as readonly string[]).includes(rawTemplate)) return undefined;
  const template = rawTemplate ? (rawTemplate as Template) : undefined;

  // command 省略时等于 trigger 本身（/btw -> /btw），派发时一律不带斜杠。
  const declared = typeof raw.command === "string" ? raw.command.trim() : "";
  const command = (declared || trigger || "").replace(/^\/+/, "");
  if (!command) return undefined;

  const rule: Rule = { command };
  if (trigger) rule.trigger = trigger;
  if (template) rule.template = template;
  if (match) rule.match = match;
  if (typeof raw.argsPrefix === "string" && raw.argsPrefix.trim()) rule.argsPrefix = raw.argsPrefix.trim();
  return rule;
}

function readConfig(path: string): { rules?: Rule[]; error?: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) return { rules: [] };
    const rules = parsed.rules.map(normaliseRule).filter((rule): rule is Rule => rule !== undefined);
    return { rules };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function globalConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, CONFIG_FILE);
}

/** 同名命令冲突时 Pi 会加后缀（`/btw:1`），派发裸名会落空变成普通消息。 */
function resolveCommandName(name: string, registered: ReadonlySet<string>): string {
  if (registered.size === 0 || registered.has(name)) return name;
  const suffixed = [...registered].filter((candidate) => candidate.startsWith(`${name}:`)).sort();
  return suffixed[0] ?? name;
}

function describeRule(rule: Rule): string {
  const matcher = rule.trigger
    ? `trigger "${rule.trigger}"${rule.template === "command-mid" ? " [command-mid]" : ""}`
    : `match ${rule.match}`;
  const sameAsTrigger = rule.trigger !== undefined && rule.trigger.replace(/^\/+/, "") === rule.command;
  const target = sameAsTrigger ? "" : ` -> /${rule.command}`;
  const prefix = rule.argsPrefix ? ` +args "${rule.argsPrefix}"` : "";
  return `${matcher}${target}${prefix}`;
}

export default function suffixCommand(pi: ExtensionAPI) {
  /** 同一条坏规则只提示一次。 */
  const reported = new Set<string>();

  function reportOnce(ctx: ExtensionContext, key: string, message: string, level: "info" | "warning" = "warning") {
    if (reported.has(key)) return;
    reported.add(key);
    ctx.ui.notify(message, level);
  }

  function dispatchableCommands(): Set<string> {
    return new Set(pi.getCommands().map((command) => command.name));
  }

  /** 没有配置文件时的内置规则：每个已注册命令一条 `/命令`。 */
  function builtinRules(): Rule[] {
    const names = [...dispatchableCommands()].filter((name) => name !== COMMAND_NAME).sort();
    return names.length > 0 ? names.map((name) => ({ trigger: `/${name}`, command: name })) : [FALLBACK_RULE];
  }

  /** 全局配置覆盖内置规则，项目配置覆盖全局配置。 */
  function loadRules(ctx: ExtensionContext): { rules: Rule[]; sources: string[] } {
    let rules: Rule[] | undefined;
    const sources: string[] = [];

    const globalPath = globalConfigPath();
    const globalConfig = readConfig(globalPath);
    if (globalConfig) {
      sources.push(globalPath);
      if (globalConfig.error) reportOnce(ctx, globalPath, `${globalPath}: ${globalConfig.error}`);
      if (globalConfig.rules && globalConfig.rules.length > 0) rules = globalConfig.rules;
    }

    if (ctx.isProjectTrusted?.() === true) {
      const projectPath = join(ctx.cwd, PROJECT_CONFIG_DIR, CONFIG_FILE);
      const projectConfig = readConfig(projectPath);
      if (projectConfig) {
        sources.push(projectPath);
        if (projectConfig.error) reportOnce(ctx, projectPath, `${projectPath}: ${projectConfig.error}`);
        if (projectConfig.rules && projectConfig.rules.length > 0) rules = projectConfig.rules;
      }
    }

    return { rules: rules ?? builtinRules(), sources };
  }

  function compiledRules(ctx: ExtensionContext): { rules: CompiledRule[]; sources: string[]; broken: string[] } {
    const { rules, sources } = loadRules(ctx);
    const compiled: CompiledRule[] = [];
    const broken: string[] = [];
    for (const rule of rules) {
      const result = compileRule(rule);
      if (result) compiled.push(result);
      else broken.push(describeRule(rule));
    }
    for (const rule of broken) reportOnce(ctx, `rule:${rule}`, `规则无效（trigger/match 缺失或正则写错）：${rule}`);
    return { rules: compiled, sources, broken };
  }

  /** 把输入解析成三个槽位，并算好最终派发的命令。 */
  function evaluate(text: string, ctx: ExtensionContext): Evaluation | undefined {
    const { rules } = compiledRules(ctx);
    const dispatchable = dispatchableCommands();

    for (const compiled of rules) {
      const parsed = parseWith(compiled, text);
      if (!parsed) continue;

      const target = resolveCommandName(parsed.cmd, dispatchable);
      const merged = [compiled.rule.argsPrefix, parsed.args].filter(Boolean).join(" ");
      const command = merged ? `/${target} ${merged}` : `/${target}`;
      const error = dispatchable.has(target)
        ? undefined
        : `规则命中 /${parsed.cmd}，但它不是可派发的命令（扩展命令 / skill / prompt 模板）`;
      return { parsed, command, error };
    }

    return undefined;
  }

  /** 等当前这次提交收尾后再派发，避免重入 prompt 管道。 */
  function dispatch(command: string) {
    setTimeout(() => {
      pi.sendUserMessage(command, { expandPromptTemplates: true });
    }, 0);
  }

  function saveConfig(ctx: ExtensionContext, text: string): boolean {
    try {
      JSON.parse(text);
    } catch (error) {
      ctx.ui.notify(`JSON 无效：${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    const path = globalConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    ctx.ui.notify(`已保存 ${path}（立即生效）`, "info");
    return true;
  }

  function scaffold(): string {
    return `${JSON.stringify({ rules: [{ trigger: "/btw" }] }, null, 2)}\n`;
  }

  pi.registerCommand(COMMAND_NAME, {
    description: "Show rules, parse a sample (--test), or manage config (--init / --edit)",
    handler: async (args, ctx) => {
      const flag = args.trim();
      const path = globalConfigPath();

      if (flag === "--init") {
        if (existsSync(path)) {
          ctx.ui.notify(`${path} 已存在，用 /${COMMAND_NAME} --edit 修改`, "info");
          return;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, scaffold(), "utf8");
        ctx.ui.notify(`已创建 ${path}`, "info");
        return;
      }

      if (flag === "--edit") {
        if (ctx.hasUI === false) {
          ctx.ui.notify(`请在 TUI 里编辑，或直接改 ${path}`, "warning");
          return;
        }
        const current = existsSync(path) ? readFileSync(path, "utf8") : scaffold();
        const edited = await ctx.ui.editor(CONFIG_FILE, current);
        if (edited === undefined || edited.trim() === "") return;
        saveConfig(ctx, edited);
        return;
      }

      if (flag.startsWith("--test")) {
        const sample = args.trim().slice("--test".length).trim();
        if (!sample) {
          ctx.ui.notify(`用法：/${COMMAND_NAME} --test 你的示例输入`, "info");
          return;
        }
        const result = evaluate(sample, ctx);
        if (!result) {
          ctx.ui.notify(`没有规则命中：${JSON.stringify(sample)}`, "info");
          return;
        }
        ctx.ui.notify(
          [
            `输入：${JSON.stringify(sample)}`,
            `input（草稿）：${JSON.stringify(result.parsed.input)}`,
            `cmd：/${result.parsed.cmd}`,
            `args：${JSON.stringify(result.parsed.args ?? "")}`,
            `派发：${result.command}`,
            result.error ? `⚠️ ${result.error}` : "回车后输入框：上面的 input",
          ].join("\n"),
          result.error ? "warning" : "info",
        );
        return;
      }

      const { rules, sources } = loadRules(ctx);
      const where = sources.length > 0 ? sources.join("\n") : `${path}（还没创建，用内置规则）`;
      const listing = rules.map((rule) => `· ${describeRule(rule)}`).join("\n");
      ctx.ui.notify(
        `配置：${where}\n\n${listing}\n\n` +
          `槽位：input=草稿、cmd=命令、args=参数。\n` +
          `试解析：/${COMMAND_NAME} --test 某段示例输入`,
        "info",
      );
    },
  });

  pi.on("input", (event, ctx) => {
    // 不拦截扩展自己注入的消息，避免循环。
    if (event.source === "extension") return { action: "continue" };
    if (!event.text.trim()) return { action: "continue" };
    // 整段以命令开头，交给 Pi 自己的命令路径。
    if (event.text.trimStart().startsWith("/")) return { action: "continue" };
    // 附件没法塞回编辑器，不拦截。
    if (event.images && event.images.length > 0) return { action: "continue" };

    const result = evaluate(event.text, ctx);
    if (!result) return { action: "continue" };

    ctx.ui.setEditorText(result.parsed.input);
    if (result.error) {
      // 别把 "/xxx" 当普通消息发给模型：草稿留下，只提示。
      ctx.ui.notify(result.error, "warning");
      return { action: "handled" };
    }

    dispatch(result.command);
    ctx.ui.setStatus(STATUS_KEY, `${result.command.split(/\s+/)[0]} dispatched, draft kept`);
    setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 2500);

    return { action: "handled" };
  });
}
