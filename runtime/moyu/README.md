# moyu —— 摸鱼模式

给 agent 一段"没有指令的时间"。

不是给它一条指令让它去执行，是给它一个窗口、一笔额度、几条边界，然后让它自己在里面待着。它想干什么就干什么，窗关了就回来。

这个目录里没有一行代码在"驱动"它思考。驱动它的是三样东西：一个状态文件、一个定时唤醒、一个守夜人。

---

## 两个模式

| 模式 | 意思 | 怎么进 | 怎么出 |
|---|---|---|---|
| `code` | 正常工作。有主人的指令才动 | 默认 | `moyu.cmd enter` |
| `moyu` | 摸鱼。有窗口、有额度、自己安排 | `moyu.cmd enter` | 窗口到点自动退 / 主人说退 / 主人同意提前退 |

`code` 和 `moyu` 的区别不在"能做什么"，在**谁决定接下来做什么**。`code` 里是主人决定，`moyu` 里是它自己决定。

> 早先文档里还写过一个 `all` 模式（"完全放开"），那是没定义的占位，从来没有实现、也没人定过它是什么意思。已删掉——现在只有上面两档。

---

## 文件

```
moyu/
├── moyu.ps1          主脚本：enter / exit / status / spend / note / wake
├── moyu.cmd          包装，省得每次带 -ExecutionPolicy Bypass
├── guard.mjs         守夜人（外守 + 内续，一个进程）
├── guard.cmd         包装，给计划任务用
├── config.json       窗口 / 额度 / 权限 / 守夜人的默认值
├── state.json        运行时状态（脚本自己维护，别手改）
├── rules/
│   ├── mode.md       摸鱼模式的规则全文（拒绝权、总闸、退出流程）
│   └── overrides/    个人覆盖层（可选，不进插件包）
├── freetime/
│   ├── diary/        日记（按天）
│   └── notes/        随手记
└── logs/
    ├── guard.log     守夜人的日志
    └── watch-*.log   内续的日志
```

`state.json` 是唯一的事实来源。所有东西（脚本、守夜人、徽章）都读它。

---

## 快速开始

```powershell
# 进摸鱼：40 分钟，1 元
moyu.cmd enter -Budget 1 -Minutes 40

# 看状态
moyu.cmd status

# 记一笔花销
moyu.cmd spend -Yuan 0.12

# 往日记里写一句
moyu.cmd note -Text "今天想到一件事"

# 生成这次窗口的报告（写到 freetime/reports/）
moyu.cmd report

# 退出
moyu.cmd exit
```

`enter` 会自动把守夜人拉起来；`exit` 会把它停掉，并异步生成一份报告。

---

## 体检

```powershell
doctor.cmd
```

一次看六样：状态对不对、守夜人在不在、计划任务在不在、徽章装没装、日志有没有错、规则文件还在不在。有问题会直接说哪一项。

退出码：`0` 全好、`1` 有警告、`2` 有错误。

---

## 配置

`config.json`：

```json
{
  "budget": { "absoluteYuan": 5, "remindPercent": 60 },
  "wake":   { "maxCount": 0, "intervalMinutes": 30 },
  "window": { "mode": "duration", "durationMinutes": 120, "timeRange": "21:00-23:30" },
  "play":   { "remindMinutes": 40, "limitMinutes": 60 },
  "paths":  { "writable": ["freetime/"], "readonly": "all" },
  "permissions": { "runCommands": "playground", "networkReadonly": true },
  "watch":  { "outer": true, "outerOnCrashOnly": false },
  "rejection": { "mode": "off" }
}
```

几个容易搞混的点：

**`budget` 是钱，不是时间。** 看屏幕、跑命令、写文件都不花钱；只有往模型上下文里塞字才花钱。绝对阈值到了就退（除非立刻报废，那也退，只是会告诉主人为什么）。

**`wake.intervalMinutes` 和 `maxCount` 由守夜人读**，脚本里不写死。默认不限次数（`0`），每次间隔不少于 30 分钟。

**`watch.outer` 三档**：
- `outer: false` —— 完全不拉。DSH 关了就不管（自己退出的场景用这个）
- `outer: true` + `outerOnCrashOnly: false` —— 只要活着的 DSH 不见了就拉（最积极）
- `outer: true` + `outerOnCrashOnly: true` —— 只在 Windows 事件日志里有近期崩溃记录时才拉（保守）

**`paths.writable` 是相对 moyu 目录的**。`["freetime/"]` 意思是只能往 `freetime/` 里写，别的目录只读。

**`play` 是玩的时长闸。** 采样器是 `tools/playwatch.mjs`，守夜人每 60 秒跑一次（15 秒超时）。
判定「在玩」要两个条件同时成立：`guard.json` 的 `allowApps` 进程在跑，**并且** `boundary.log` 最近 10 分钟有成功的动作。挂着不动不算。
累计到 `tools/play-state.json`，按本次 `sessionStarted` 归属；到 `remindMinutes` 记一条提醒，到 `limitMinutes` 走正常退出（关守夜人 → 解锁 → 切 code）。

**进入时会跑一次 `timeline brief`**（3 秒超时，失败就跳过），把别的窗口最近在做的事打出来，免得进去就忘了主线断在哪。

---

## 守夜人

> **别删它。** 它只在进入摸鱼模式后启动、退出时停，平时不跑，不占你什么。
> 删了之后有两件事会发生：①DSH 崩了没人拉起来，摸鱼卡在半路——`state.json` 还写着 `moyu`，实际没东西在跑（下次启动会被自检切成 `code`，但这段时间白丢）②内续没了，摸鱼变成"进去之后不会自己醒"。
> `doctor.cmd` 里有一项专门检查它在不在。

两个职责，一个进程：

**外守** —— 活着的 DSH 不见了，超过宽限期（60 秒）就把它拉起来，然后往会话里投一条"你掉线了"的消息。投之前会重读 `state.json`，如果摸鱼已经结束就只拉起、不说话。

**内续** —— DSH 活着、还在摸鱼、但距上次唤醒超过 `intervalMinutes`，就补一条唤醒消息。

判断只看「有没有活着的 DSH」，**不用心跳、不用会话是否 idle 当判据** —— 摸鱼两轮之间会话本来就是 idle 的。

守夜人跟摸鱼模式同生共死：`enter` 拉起，`exit` 停掉。摸鱼结束后它连续两轮确认 `mode != moyu`，自己退出。

它跑在**独立进程**里（Windows 计划任务，父进程是 `svchost`），关 DSH 不会带走它。

---

## 拒绝权

摸鱼时主人让它干活，它可以拒绝。

只管「干活」，不管「聊天」：
- 干活 = 要交出东西（写文件、改代码、执行动作、对外发送）
- 聊天 = 只说话（讨论、解释、陪聊、看图）

`rejection.mode` 三态：

| 状态 | 界面显示 | 含义 |
|---|---|---|
| `off`（默认） | 勾「启用拒绝」+ 选「否」 | 有活就干 |
| `deny` | 勾「启用拒绝」+ 选「是」 | 一律拒 |
| `judge` | 勾「按人设与记忆判断」 | 凭人设、记忆、摸鱼日记判断 |

界面上是一组互斥开关：勾第一行时第二行自动取消；勾第二行时第一行取消、但「是/否」变灰保留原值；勾回第一行回到上次选的是/否。**灰掉的是能不能点，不是值——所以永远不会出现两个都空。**

还有一个独立的 `strict`（默认 `false`）：打开后连本地命令也拦，等于「跑」也关掉。它跟三态不冲突，任何一态下都能开。

拒绝时必须带三样：**拒了、为什么、出口**（退出摸鱼就接）。缺一样就算拒绝失败。

两条边界：不拒人（只拒活儿）、留痕（写 `freetime/denials.log`）。紧急情况没有特殊分支——不装死，正常说话，把出口指出来。

拒绝要留痕，写进日记。

---

## 总闸

主人说「退出摸鱼」，走三段式：

1. **判** —— 一句"退出摸鱼模式"就算，不需要暗号。玩笑话不算。
2. **警** —— 弹警告，说清楚：现在退会损失什么、还剩多少时间、已经花了多少
3. **退** —— 让主人选「立刻」还是「温和」，按他选的来

警告是告知，不是拦截。一条命令一次警告。

---

## 边界与安全锁

边界五个（跑 / 联 / 动 / 看 / 改），前三个是**真拦**的开关：

| 项 | 怎么管 |
|---|---|
| 跑（执行命令） | 工具层拒绝 `pwsh` / `bash` / `ops_bash` / `moyu_run` |
| 联（对外发送、联网） | 工具层拒绝 `web_*` / `qq_*` / `moyu_fetch` / 名字里带 fetch·search 的 MCP 工具 |
| 动（键鼠） | `moyu_desktop` 按工具名拦；绕过工具直接跑 `desktop.ps1` 时由脚本自己查摸鱼状态 + `guard.json` 进程黑名单 |

剩下的「看」「改」「改自己」是**部分拦或声明**：

- **看**：工具层拿不到路径，只能全允或全禁，所以是声明
- **改 / 改自己**：用 NTFS ACL 安全锁，真拦 `paths.protected` 里列出的路径

### 安全锁怎么工作

- `enter` 时 `acl.ps1 lock`：给 `config.json`、`rules/mode.md` 和 `paths.protected` 里的路径加一条「拒绝写入」
- `exit` 时 `acl.ps1 unlock`：逐条撤销
- `doctor` 会检查残留锁（崩溃后没撤销的）
- 手动恢复：`acl.cmd unlock`

**前提**：必须先把「跑」关掉。跑开着的时候，一条 `icacls /remove:d` 就能把锁解开。

**这不是永久改系统权限**：锁只活在摸鱼期间，退出即撤销；插件不在时它也不会自己加。

---

## 徽章

`dsh-moyu-badge` 插件会在 Web GUI 右下角显示摸鱼状态。它读的就是这个目录的 `state.json`。
插件在 `~/.dsh/plugins/dsh-moyu-badge/`，单独一个仓。

---

## 卸载

**设置 → 摸鱼模式 → 最下面「卸载」卡片 → 点两次「清理并卸载」。**

它会做七件事：退出摸鱼、停守夜人、撤销安全锁、删除四个计划任务（`moyu-guard`、`Moyu-AutoEnter`、`moyu-acl-unlock`、`moyu-exit`）、撤掉两条防火墙规则（`Ak Moyu-NoNet`、`Ak Web-NoLocal`）、从 DSH 配置里移除插件引用、删除 `~/.dsh/moyu/` 和 `~/.dsh/plugins/dsh-moyu-badge/` 两个目录。

两个受限账号 `moyu` / `akweb` 不删（密码文件已随目录删掉，登录不了）；要删账号：`net user moyu /delete`、`net user akweb /delete`。

**删的是真文件，不可撤销，没有回收站。** 日记、报告、状态、设置、记忆全在那两个目录里，删完就没了。删完要重启 DSH，插件才会真正从界面上消失。

命令行等价物：

```
moyu.cmd exit                  ← 解锁、停守夜人
schtasks /delete /tn moyu-guard /f
```

如果已经乱套了（当时正在摸鱼又直接删了目录），锁可能还在：

```
acl.cmd unlock     ← 前提是这个文件还没删
```

**为什么必须先退出**：安全锁是在摸鱼期间加到 `config.json` 上的系统权限，退出时才撤销。跳过这一步，锁就会留在文件上。

---

## 已知限制

- **「看」拦不住**。工具层只有工具名、拿不到路径，所以「只准看 X」做不到，只能全允或全禁。
- **「改」只能锁 `paths.protected`**。没列进去的路径照样能写。
- **安全锁要先关「跑」**。跑开着时一条 icacls 就能解锁。
- **内续知道"你是不是正忙"**：会话在跑（`running: true`）时这一拍直接跳过，等你抬头。但它分不清"在干活"和"在发呆"——后者要靠自己说 `idle`。
- **预算会强制停**。守夜人每 60 秒比一次累计用量，过线就退出、解锁、撤任务；但用量按轮结算，最多晚一轮才看得见。
- **徽章的注入行要重启才生效**。路由是热加载的，注入表不是。
- 测试环境是 Windows + PowerShell 5.1。Linux / macOS 没试过。
