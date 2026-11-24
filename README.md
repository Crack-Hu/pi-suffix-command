# pi-suffix-command

把 `/命令` 写在输入的任意位置，命令被派发，其余内容留在输入框。

```text
帮我重构 parseRetry，然后跑测试 /btw 为什么重试没生效
⏎
→ 派发 /btw 为什么重试没生效
→ 输入框保留：帮我重构 parseRetry，然后跑测试
```

派发的命令不会进入主 agent 的上下文，也不会写入会话记录。

## 安装

```bash
pi install git:github.com/Crack-Hu/pi-suffix-command
```

安装后在 Pi 中执行 `/reload`。更新使用 `pi update --extensions`，卸载使用 `pi remove`。

## 使用

命令可以出现在输入的任意位置，命令之后到行尾的部分作为参数传递。

| 输入 | 派发 | 输入框保留 |
|---|---|---|
| `重构 parseRetry /btw` | `/btw` | `重构 parseRetry ` |
| `草稿 /btw 为什么报错` | `/btw 为什么报错` | `草稿 ` |
| `草稿第一行` ⏎ `/btw 问题` ⏎ `草稿第三行` | `/btw 问题` | `草稿第一行` ⏎ `草稿第三行` |
| `你好/btw` | `/btw` | `你好` |
| `检查 src/btw` | 不匹配，按原样发送 | — |
| `/btw 问题` | 不匹配，由 Pi 原有命令路径处理 | — |

匹配规则：`/` 前必须是行首、空白或非 ASCII 字符（中文、全角标点），因此 `src/btw` 这类路径不会触发；命令名后必须是空白或行尾，因此 `btwx`、`/btw/foo` 不会触发。

默认情况下无需配置文件：每个已注册的命令（扩展命令、skill、prompt 模板）都可以直接以 `/名称` 的形式使用。

## 解析结果

每次提交时，输入被切分为三个槽位：

| 槽位 | 含义 | 用途 |
|---|---|---|
| `input` | 命令之外的文本 | 回到输入框，原样保留空格与缩进 |
| `cmd` | 命令 | 经规则映射后决定实际派发的命令 |
| `args` | 参数 | 附加在命令之后 |

查看某段输入的解析结果：

```bash
/suffix --test 草稿 /btw --history retry
```

```text
输入："草稿 /btw --history retry"
input（草稿）："草稿 "
cmd：/btw
args："--history retry"
派发：/btw --history retry
回车后输入框：上面的 input
```

## 配置

配置文件用于定义别名或自定义匹配方式，可选。规则按顺序匹配，第一条命中者生效。

```json
{
  "rules": [
    { "trigger": "/btw" },
    { "trigger": "/q", "command": "/btw" }
  ]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `trigger` | 与 `match` 二选一 | 字面量触发词，如 `/btw`；不加斜杠的裸词（`btw`）同样有效 |
| `match` | 与 `trigger` 二选一 | 作用于整段输入的正则，可用命名组 `input`、`args` |
| `command` | 否 | 命中后派发的命令；省略时等于 `trigger` 本身 |
| `argsPrefix` | 否 | 附加在参数之前 |

上例中 `/q 为什么` 派发 `/btw 为什么`。

### 使用 match 自定义语法

省略 `trigger` 时可直接提供正则，此时必须指定 `command`：

```json
{
  "rules": [
    {
      "match": "(?<input>[\\s\\S]*?)\\s*//review\\s+(?<args>[^\\n]*)$",
      "command": "/subagent",
      "argsPrefix": "--agent reviewer"
    }
  ]
}
```

`改这里 //review 看看 diff` 派发 `/subagent --agent reviewer 看看 diff`，输入框保留 `改这里`。

### 文件位置

| 路径 | 作用范围 |
|---|---|
| `~/.pi/agent/suffix-command.json` | 全局 |
| `<project>/.pi/suffix-command.json` | 当前项目（需项目信任），覆盖全局配置 |

修改后立即生效。仓库中的 `suffix-command.example.json` 为最小示例。

## 命令

| 命令 | 作用 |
|---|---|
| `/suffix` | 显示当前规则与配置路径 |
| `/suffix --test <示例输入>` | 显示解析结果与实际派发的命令 |
| `/suffix --init` | 生成配置文件（已存在时不覆盖） |
| `/suffix --edit` | 在 `$EDITOR` 中编辑配置，保存后立即生效 |

## 限制

- 派发目标必须是扩展命令、skill 或 prompt 模板；目标不存在时不派发，`input` 照常回到输入框并给出提示
- 带附件（图片）的输入不会被拦截
- `trigger` 规则的参数只到行尾，多行参数需要改用 `match`

MIT
