# 木牛品牌资源

`muniu-logo.png` 是用户于 2026-10-09 指定的木牛科技透明底 Logo，保留原始文件内容，作为后续品牌标识的唯一源文件。不要重新描绘、变形、裁切或替换颜色。

应用内使用透明 Logo；深色界面通过白底容器保证识别。桌面启动图标使用白色圆角底，四角外留透明边距，保留原图比例。

安装锁定依赖后，在仓库根目录执行：

```bash
node scripts/generate-brand-assets.mjs
```

脚本将原图嵌入 `apps/desktop-mac/src-tauri/app-icon.svg`，使用已锁定的 Tauri 图标工具生成各尺寸图标，并同步 Desktop 与文档站的静态资源。原图保持不变；生成的 PNG、ICNS、ICO 是打包所需资源，应与源文件一起提交。
