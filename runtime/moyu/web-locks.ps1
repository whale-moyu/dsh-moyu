# web-locks.ps1 —— 已停用（2026-11-17）
#
# 原来这里是「浏览器两道临时锁」的机器级那一半：往 HKLM 写
#   Software\Policies\Microsoft\Edge\FileUrlNavigationEnabled = 0
# 用来禁掉 file:// 导航。
#
# 2026-11-17 实测：这版 Edge（1.3.315.17）能读到这条策略，但状态是「错误」，
# 不执行。写到 HKLM 和写进 akweb 自己的 hive 都一样。所以它从来没真正拦过东西，
# 只是在每次摸鱼时改一遍注册表。
#
# 现在由三件事接管：
#   1) web-cdp.mjs 的 nav 直接拒 file://
#   2) akweb 的 ACL 收窄（D:\、E:\、你的用户目录全部禁读）
#   3) 页面级 shim 拦「把文件内容发出去」（config.json 的 web.blockRawUpload）
#
# 这个文件只留作记录。要恢复当年的行为，去 TASKS.md 搜 FileUrlNavigationEnabled。
Write-Output 'web-locks.ps1 已停用：这版 Edge 不认 FileUrlNavigationEnabled 策略。详见文件头注释。'
