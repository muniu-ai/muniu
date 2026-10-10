# 仓库登记体验优化

范围：让用户从快速捕获和 Coding 仓库列表直接登记本地仓库。桌面版提供原生文件夹选择，浏览器保留路径输入。成功后选中新仓库，保留任务草稿；取消选择不写入，响应丢失后使用同一幂等键重试。

Host 契约、事件、执行前的仓库检查和沙箱策略保持现有语义。登记仅保存路径，不初始化、克隆或修改仓库。目录选择通过有限的桌面命令实现，不开放通用文件系统权限。

## 实施与验证

1. 添加真实 Host UI 回归，先确认当前界面缺少入口，再实现共享登记窗口。
2. 覆盖首次登记、取消、手动输入、原生选择失败、中文及空格路径、多仓库选择、同路径复用和响应丢失后的重试。
3. 执行 `npm run verify:repositories-ui`、`npm run verify:coding-ui`、`npm run verify:onboarding-ui`，检查 1180 和 960 像素布局。
4. 执行 `npm test`、`npm run typecheck`、`npm run typecheck:desktop`、`npm run build:desktop`、Rust crate 下的 `cargo test --locked`、`npm run verify:enterprise-fixture`、`npm audit --omit=dev` 和 `git diff --check`。
5. 构建通用 macOS 应用，验证安装包，备份后更新本地应用，实测原生目录选择和取消登记。

不涉及 npm 发布、远程发布或数据迁移。
