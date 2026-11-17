# dsh-moyu · 摸鱼模式

给你的 agent 一段自己支配的时间，同时把它的手脚钉在一小块地上。

> Windows only. 需要管理员权限、PowerShell 5.1、DSH ≥ 0.1.0-rc.6。

## 它做什么

- **一段有边界的自由**：设一个窗口（时长 / 额度），窗口内它自己安排做什么；到点自动收，超预算自动停。
- **跑 = 一块地盘**，不是「放开命令」：能写哪个目录、能起哪个程序、能不能出网、多少秒超时。
- **换身份执行**：命令以受限本地账号 `moyu` 跑，写别处被 Windows 拒，不是靠插件「记得拒绝」。
- **四道闸互相包含**：关掉「联」连带关掉「跑」和「社交」。
- **边界被外面改过，当场退出**：进摸鱼时给边界拍指纹，中途被人改了下一次动作就拒。
- **退出给一份人读的报告**：碰了哪些文件、起过什么、被拒几次、去过哪些网站。
- **还有一档「严格」**：连退出都要口令，动手前得先写一行「我现在要干什么」。

## 仓库结构

```
package.json                  插件本体（这个仓库根目录就是一个包）
lib/ client/                  插件代码
runtime/moyu/                 主程序（PowerShell + Node 脚本，装到 %USERPROFILE%\.dsh\moyu\）
market/index.json             插件市场索引（格式 1）
```

**插件自带主程序**：`runtime/moyu/` 里是同一份脚本，插件加载时会按 sha256 差量铺到 `%USERPROFILE%\.dsh\moyu\` —— 只补缺的和改过的，`config.json`、`state.json`、`freetime/`、`logs/`、`secrets/` 这些用户数据一个都不碰。所以**装插件就够了**，不用手动拷两半。

仓库根就是包本身，所以从 git 装不需要 `&path:`：`git+https://github.com/whale-moyu/dsh-moyu.git#<commit>` 即可。

## 安装

**方式一：从插件市场装（推荐）**

打开 **插件 → 发现 → 添加索引源**，填这个地址：

```
https://whale-moyu.github.io/dsh-moyu/market/index.json
```

然后在「摸鱼模式」那张卡上点 **安装**。装完重启 DSH，主程序会自己铺到 `%USERPROFILE%\.dsh\moyu\`。

**方式二：手动装**

见 `runtime/moyu/README.md` 与包里生成的 `INSTALL.md`（`moyu/pack.ps1` 会打出一个含 `INSTALL.md` 的 zip）。

六步自查在 `INSTALL.md` 第三节。最后一步是**真拦一次**——体检通过不等于拦得住。

## 已知限制

1. 上传只挡一半：裸 `body` 与 `multipart` 被拦，HTTPS body 对代理不可见。
2. `file://` 没有系统级禁令：这版 Edge 不执行那条策略（实测状态「错误」）。现在靠工具层拒绝 + 浏览器账号读不到用户目录。
3. 连续操作要用 `moyu_desktop` 的 `seq`：两次工具调用之间隔 0.9 秒，游戏不认。

## 它会改你的机器

建两个本地账号（`moyu`、`akweb`）、加两条防火墙规则（`Ak Moyu-NoNet`、`Ak Web-NoLocal`）、写 `%USERPROFILE%\.dsh\moyu\` 与 `%USERPROFILE%\.dsh\plugins\dsh-moyu-badge\`、可选两个计划任务（`moyu-guard`、`Moyu-AutoEnter`）。

卸载见 `INSTALL.md` 第五节，设置页里也有「卸载」按钮。

## 许可

MIT，见 LICENSE。

## 包里没有什么

不随包分发立绘、房间、语音模型、任何人的真实音色。
