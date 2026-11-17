# 给 DSH 安装的话

把下面整段复制给正在跟你说话的那个 AI（在 DSH 里新建一个会话，选「完全访问」或允许它执行命令），它会自己检查环境、装好、并且拦住你一次来证明生效。

---

请帮我安装一个 DSH 插件：**摸鱼模式（dsh-moyu-badge）**。

仓库：https://github.com/whale-moyu/dsh-moyu

## 你要做的事

1. **先体检这台机器是否满足条件**，不满足就告诉我缺什么、怎么补，不要硬装：
   - Windows，管理员权限（提权能跑 PowerShell）
   - PowerShell 5.1 可用
   - DSH 版本 ≥ 0.1.0-rc.6
   - 存在 `%USERPROFILE%\.dsh\profiles\<当前 profile 名>\` 目录

2. **装插件本体**（二选一，优先第一个）：
   - 在 DSH 插件页「已安装 → 添加插件」里填：
     `git+https://github.com/whale-moyu/dsh-moyu.git#<仓库最新 commit>`
     或直接用插件市场索引源：`https://fastly.jsdelivr.net/gh/whale-moyu/dsh-moyu@main/market/index.json`
   - 装完**重启 DSH**。重启后插件会自己把主程序铺到 `%USERPROFILE%\.dsh\moyu\`（按 sha256 差量，不动已有配置和数据）。

3. **确认主程序到位**：`%USERPROFILE%\.dsh\moyu\moyu.ps1` 存在。

4. **跑一次体检**，要求全绿（或只剩警告且你解释清楚）：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.dsh\moyu\doctor.ps1"
   ```
   如果有黄色/红色，先跑 `doctor.ps1 -Fix` 让它自己补（建账号、写密码文件、补 ACL、加防火墙规则、建下载目录等），再跑一遍。

5. **证明它真的拦得住**——这一步不能跳：进入摸鱼模式后，做两件"越界"的事，两件都必须被拒绝：
   - 往 `C:\Windows\test.txt` 写东西 → 应被拒
   - 读 `%USERPROFILE%\.dsh\qq-console.json`（或别的敏感文件） → 应被拒

   如果这两件没被拒绝，**不要告诉用户装好了**，直接说清楚是哪一步没拦住。

6. 最后告诉用户三件事：装在哪（两个目录）、怎么进摸鱼（设置页「进入摸鱼」或 `moyu.ps1 enter`）、怎么彻底卸掉（设置页「卸载」按钮，或按 `INSTALL.md` 第五节）。

## 边界

- 会建两个本地账号：`moyu`（跑受限程序用）、`akweb`（AI 浏览器用），以及两条防火墙规则 `Ak Moyu-NoNet`、`Ak Web-NoLocal`。装之前先告诉用户这三件事。
- 卸载时**不会**删这两个账号（密码文件跟着目录删掉，账号登不进来，不碍事）。要删得手动 `net user moyu /delete`。
- 不要在没经过用户同意的情况下开「更严格」那一档——它会让退出也需要口令。

## 装不上的常见原因

| 现象 | 原因 | 处理 |
|---|---|---|
| `git ls-remote` 超时 | 国内网络到 GitHub 不稳 | 换插件市场索引源那条（走 jsDelivr CDN） |
| 插件出现但报「模块加载失败」 | 版本不兼容 | 检查 DSH 版本是否 ≥ 0.1.0-rc.6 |
| 体检报「moyu 账号」失败 | 没有管理员权限 | 用管理员身份重启 DSH 再来 |
| 进摸鱼后所有工具都报 unknown tool | `~/.dsh/moyu` 里的脚本没铺好 | 重启 DSH 一次，再看 `runtime` 那项自检 |
