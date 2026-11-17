# dsh-moyu-badge

> **先读这段（2026-11-16）**
>
> 这个插件的默认值是**失败关闭**：配置里没写的项，等于没有这项能力。
>
> - 「跑」默认关；要给能力，必须自己在 `config.json` 的 `scopes` 里划一块地盘。
> - 地盘要写 `"user": "moyu"`，让子进程真的以受限账号跑（先跑 `moyu/install-l3.ps1` 建账号）。**没有这个账号，`moyu_run` 会直接报错，不会偷偷退回管理员身份。**
> - 「联」「动」默认关；`allowApps` 默认空表 = 一个都不许点。浏览器不要放进白名单——浏览器是管理员身份、自己联网，「联」关着也挡不住它。
> - 两块地盘能写的地方只有 `~/AkPlay` 和 `~/.dsh/moyu/freetime`，别处由 Windows ACL 拒。
>
> 想加地盘照着 `moyu/边界模板.md` 填空，别凭感觉改 JSON。改完跑 `moyu/doctor.ps1`，14 项全绿再进摸鱼。
> 出问题把 `dist/dsh-moyu-0.1.4.zip` 解压覆盖回来即可。

摸鱼模式的**显示**部分。它只管一件事：在 Web GUI 右下角显示当前状态。

```
🐟 正在摸鱼中
```

点一下展开：剩几分钟 / 用了多少钱 / 唤醒了几次 / 玩了多久。`code` 模式显示 `🐟 代码模式`（半透明）。可以拖着挪位置。

---

## 2026-11-05 起：它不只是显示

同一份代码还管三件新事。

**1. 桌面小条**

摸鱼时屏幕右上角会有一条：「摸鱼中 · 剩 101 分 · 0.54/10.00 元」。

- 只在 `mode=moyu` 时出现，回到 code 自动隐藏
- 跟着前台窗口所在的那块屏走，换屏才挪位置
- 鼠标左键在上面快速点两下就关；下次进摸鱼会自己起来
- 实现在 `~/.dsh/moyu/tools/moyu-float.ps1`（WinForms）+ `moyu-float.vbs`（无窗口拉起），**不再依赖 electron**

起停由插件负责：`lib/index.js` 里的 `syncFloat(st)` 每 30 秒对一次状态，该起就起、该停就停。

**2. 设置页**

左下角 设置 → 摸鱼模式，现在是 6 个页签：概览 / 时间 / 能力 / 断线 / 意愿 / 扩展，页签下面是一条常驻操作条（保存设置 / 进入摸鱼 / 退出摸鱼 / 撤销安全锁）。

每个页签下面是若干张卡片，**一张卡一件事**，卡片标题写成「这次开多久」「花到多少钱就停」这种大白话。页签和卡片是两层名字：页签短（时间、能力、断线、意愿），长名字全留给卡片。

吸顶条左边是页签名，右边是当前页的卡片目录（小标题），**点一下就滚到那张卡片**，滚到哪张哪个就高亮。清单在 `client/client.js` 的 `TAB_CARDS`，改一处两边跟着变。

「连线」（原「视频通话」）只有字幕设置这一张卡，在「扩展」页；3D 房间那套还在做，没接完。

「玩」页签能改展示用的两条线：提醒（默认 40 分）、强制退出（默认 60 分）。
「桌面显示框」开关在概览页，关掉小条就不出现（写 `config.json` 的 `float.enabled`）。

**3. 玩时长**

`playwatch.mjs` 每分钟采一次，`play-state.json` 记这次的累计时长，徽章和设置页都读它。判定：游戏进程在（`guard.json` 的 `allowApps`）+ 最近 10 分钟有真实键鼠动作（`boundary.log` 里 `result=ok` 的行）。

---

## ⚠️ 先读这一段：守夜人不在这个插件里

这个插件**不负责**让摸鱼模式活着。真正管这件事的是另一个东西：**守夜人**。

- 位置：`~/.dsh/moyu/guard.mjs`
- 托管：Windows 计划任务 `moyu-guard`（父进程是 `svchost`，不在 DSH 进程树里）
- 生命周期：`moyu.cmd enter` 时启动，`exit` 时停止。平时不常驻。

它做两件事：

- **外守** —— DSH 崩了或被关掉超过 60 秒，把它拉起来，然后往会话投一条「你掉线了」的消息
- **内续** —— DSH 活着、还在摸鱼、但距上次唤醒超过 `intervalMinutes`，补一条唤醒消息

### 删掉守夜人会怎样

**DSH 崩了没人拉。** 摸鱼窗口会卡在半路：`state.json` 还写着 `moyu`，但实际没有东西在跑。下次 DSH 启动时，插件里的启动自检会把它切成 `code`（有兜底，不会永远卡着），但**这段时间就白丢了**——预算照记、时间照走，你却不在。

**内续也没了。** 摸鱼退化成"一次性的"：进去之后不会自己醒来，除非有人发消息给你。

### 守夜人不管什么（别指望它）

- **不管关机**。电脑关了它也不在。关机期间窗口照常流逝但不 tick，退出会延迟到下次 `moyu.cmd status` 才补上。
- **不管进程被强杀**（任务管理器里手动结束）。
- 它只在进入摸鱼模式后启动。`mode=code` 时不跑。

### 所以

想删它可以，但先确认你知道上面两条。如果不是因为"我不需要摸鱼模式"，就别删——`doctor.cmd` 里有一项专门检查它在不在。

---

## 它怎么工作（插件本身）

三个部件，都在 `lib/index.js` 里：

1. **注入行**（`webserver/index-inject`）—— 往页面里塞一个内联 `<script>`，由它去加载 `badge.js`
2. **`GET /dsh-moyu/badge.js`** —— 客户端脚本，约 3.5 KB，原生 JS，无依赖
3. **`GET /api/dsh-moyu/state`** —— 读 `state.json`，算好 `leftMinutes` 再返回

客户端每 30 秒轮询一次；页面重新可见时也拉一次。拖过的位置存在 `localStorage` 里。

## 数据从哪来

它只读一个文件：

```
$DSH_MOYU_DIR/state.json      # 没设这个环境变量就是 ~/.dsh/moyu/state.json
```

读不到、或者文件坏了，徽章就安静地不显示，不报错。

2026-11-05 起还会读一个可选文件（读不到就只是不显示玩时长，其它照旧）：

```
$DSH_MOYU_DIR/tools/play-state.json   # { "playMs": 1234567, ... }
$DSH_MOYU_DIR/config.json              # play.remindMinutes / play.limitMinutes
```

有就显示「玩了 X / 60 分」，到提醒线变黄。

## 安装

```powershell
# 1. 放进插件目录
#    C:\Users\<you>\.dsh\plugins\dsh-moyu-badge\

# 2. profile 的 package.json 加一行依赖
#    "dsh-moyu-badge": "link:C:/Users/<you>/.dsh/plugins/dsh-moyu-badge"

# 3. pnpm install

# 4. dsh.profile.bundles 里加 "dsh-moyu-badge"

# 5. 重启 DSH

# 6. 体检，缺什么让它自己补
powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\.dsh\moyu\doctor.ps1 -Fix
```

`doctor.ps1` 现在是「体检 + 一键补齐 + 可复制报告」：

| 参数 | 作用 |
|---|---|
| （无） | 只读体检，21 项，不碰任何文件 |
| `-Fix` | 缺什么补什么：建账号、写密码文件、补 ACL、加防火墙规则、建下载目录、复制 node 副本、编译隐藏启动器；补完自动复查 |
| `-Report D:\报告.txt` | 把整段结果写成文件。出问题让别人把那段发给他**自己那边**的 AI，不是发给插件作者。不加时只有出现黄/红才打印报告段 |

补不了的项（没装 Edge、不是管理员、PATH 里没有 node）会明说，不会假装成功。

## 已知限制

- **注入行要重启才生效**。路由是热加载的（改完立刻能访问），但 `webserver/index-inject`
  的注入表在宿主启动时只收集一次，没有刷新路径。所以装完第一次必须重启。
- 只对 Web GUI / 桌面端有效。终端 UI 没有页面可注入。
- 不能推 `kind: 'script-src'` 行：页面侧对它是 `await loadScript`，失败会 reject 掉
  `__DSH_BOOT_READY__`，整个应用起不来。所以走内联 script + 自己吞 onerror。
- 只认回环 Host（`localhost` / `127.0.0.0/8` / `::1`），别的来源返回 403。

## 卸载

从 `dsh.profile.bundles` 里删掉 `dsh-moyu-badge`，重启。

**别顺手把 `~/.dsh/moyu/` 也删了**——守夜人、日记、配置全在那。要删那边，先看上面那段。
## 两个受限账号叫什么（accounts-naming）

| 账号 | 中文叫法 | 能做什么 |
|---|---|---|
| `moyu` | 摸鱼账号 | 能写 playground 与 freetime，不出网 |
| `akweb` | 浏览器账号 | 能上网，碰不到用户目录 |
## 摸鱼里能用什么工具（含 AI 浏览器）

摸鱼时工具名走白名单：写文件、读图片、`moyu_*`、QQ 只读与发消息（受「社交」再判）、`web_search` / `web_fetch`。别的工具一律拒。

**AI 浏览器**用 `moyu_web`：
- `{action:"start", url:"https://…"}` 起（先确保代理活着，再以 `akweb` 身份起 Edge）
- `{action:"cmd", args:["nav","https://…"]}` 发一条 `web-cdp.mjs` 命令（`list/nav/title/text/click/type/press/scroll/wait/eval/shot/usage`）
- `{action:"status"}` 看代理与调试端口；`{action:"stop"}` 关

三条硬约束：
1. 只在摸鱼模式里能用——代理与浏览器跟着摸鱼起停，代码模式下会直接拒（不是「起了又死」）。
2. 出网只走 `127.0.0.1:9334` 代理：只放 80/443、只放公网 IP，回环（包含 DSH 自己的端口）与局域网一律 403。
3. 文件选择框被 CDP 挡住，页面拿不到本地文件；下载只能落 `C:\Users\akweb\Downloads\ak-inbox`，事件写 `freetime/web-downloads.log`。

`file://` 只有 `web-cdp` 层拒绝：Edge 自己的策略写不进去（`akweb` 没有独立注册表配置单元），而它本来就读不到用户目录。
