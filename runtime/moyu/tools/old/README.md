# 归档的小工具（2026-11-17）

这四个脚本在 2026-11-17 的清点里**没有任何地方引用**，挪到这里留着，不删。

| 文件 | 以前干什么 | 为什么归档 |
|---|---|---|
| `absmove.ps1` | 绝对坐标移动鼠标 | `desktop.ps1` 的 `move` 已经覆盖 |
| `relmove.ps1` | 相对坐标移动鼠标 | 同上 |
| `dblclick.ps1` | 双击 | `desktop.ps1` 的 `click` 现在一条命令搞定 |
| `mapscan.ps1` | 扫地图格子 | 极简塔防那次用的，`siege.ps1` + `grid.mjs` 已经替代 |

**要恢复**：`Move-Item` 挪回 `tools/` 即可，它们不依赖别的东西。
注意这四份是**没有 BOM** 的（PS 5.1 会按 ANSI 读，中文注释变乱码）——真要恢复，先补 BOM：

```powershell
$f='...\tools\absmove.ps1'
$s=[System.IO.File]::ReadAllText($f,[Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
[System.IO.File]::WriteAllText($f, ([string][char]0xFEFF)+$s, (New-Object Text.UTF8Encoding($false)))
```
