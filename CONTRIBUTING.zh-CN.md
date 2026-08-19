# 贡献 Muniu

使用 Node 22.19.x、npm 11.10.1 和独立 Git worktree。安装必须运行 `npm ci`。生产改动先增加聚焦失败测试，再实现、运行受影响 workspace 测试和仓库门禁。

提交前至少运行：

```bash
npm run build
npm run typecheck
npm test
npm run verify:enterprise-fixture
npm audit --omit=dev
git diff --check
```

修改 vendored Cordis 时必须更新来源、逐文件哈希、许可证和差异说明。插件 API 变更必须说明 process-equivalent trust 影响。安全问题请使用 GitHub 私密漏洞报告。
