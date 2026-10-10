# P5 固定成果导出与派生资料

本阶段把目标的一项固定成果导出为 DOCX、PDF 或 XLSX，文件仍通过现有受保护 Asset 读取。导出只保存成果副本，不修改业务事实，也不表示客户验收或实际收款。

## 接口与提交

- `POST /v2/goals/{goalId}/exports` 固定 `planRevisionId`、`deliverySetId`、`outputKey`、`outputDigest` 和 `format`。创建的是独立导出记录，因此要求 `expectedStreamVersion: 0` 与 `Idempotency-Key`。
- `GET /v2/goals/{goalId}/exports` 和单项读取都需要 `workspaceId`。下载、元信息和提取使用现有 Asset 接口。
- `assetRef.digest` 是密文 CAS 摘要；`contentSha256` 是下载明文摘要。客户端保存前核对明文大小与摘要。
- owner/operator 可以生成文件；读取仍检查当前身份、工作区成员和来源。历史固定成果可以导出，业务事实历史版本可回源；记忆、技能、MCP 连接及资料授权仍须有效。

Host 的只读成果读取器校验目标、计划、成果集合、条目与摘要，并调用原有验收证据校验。Coding 保留候选 diff、Gate、Spec、Governance、Harness、沙箱和批准候选的证据检查。读取不创建成果、决定或冻结记录。

渲染与加密在事务外进行，准备对象不含明文。提交事务再次检查来源与成果证据，然后一次写入 Asset、包装密钥、派生来源、导出记录、事件和幂等回执。竞争请求只提交一个结果；未提交的密文可由既有 CAS 清理路径回收。

## 来源继承

导出 Asset 保存来源版本、权威投影的内容摘要以及原模型调用记录的受保护密钥引用。所有 Asset 读取和模型上下文都递归检查来源；删除上游资料、撤回 MCP 连接、删除原模型请求/响应密钥或修改权威 Gate，都会阻止后续传播。成员移除后不能重放旧回执读取内容。

来源图禁止跨工作区引用、循环和过深引用。跨模块叶校验回调重新进入来源读取时也保留循环限制。通用团队技能的来源证明与实际角色资料都继承派生 Asset 的撤权；历史经营证明不会使过期记忆重新有效。

## 文件内容与限制

| 格式 | 本阶段范围 |
| --- | --- |
| DOCX | 普通段落、标题、来源和接收状态；保留文本，不解释 HTML、Markdown 脚本或外链 |
| PDF | 同一文本的固定版式，嵌入已锁定中文字体子集；缺字形明确拒绝 |
| XLSX | 单张成果表，每段占一行；全部为 `inlineStr`，以 `=`、`+`、`-`、`@` 开头的内容也不成为公式 |

没有宏、嵌入脚本、远程图片、外部关系或隐式公式计算。DOCX/XLSX 声明中文字体，由阅读软件及其可用字体呈现；PDF 自带字体。Office 文件不嵌入完整字体。

输入正文最多 1 MiB、10,000 行；标题最多 2 KiB，来源说明最多 4 KiB。输出最多 20 MiB，PDF 最多 100 页。XLSX 单元格除格式字符上限外，还受可显示行高限制，过长段落要求分段，禁止静默截断。

三种格式均在可终止子进程生成：并行 2、等待队列 6，排队和执行共用 15 秒期限；V8 heap 256 MiB，RSS 每 25 ms 检查，超过 384 MiB 终止。**RSS 是采样终止阈值，不是操作系统硬分配上限，短暂超额仍可能发生。** 子进程仅继承 UTC 与打包运行必需变量，不继承 Host 凭据或 `NODE_OPTIONS`，并禁止字符串生成代码。资料正文仅通过标准输入传入。

## 依赖、字体与打包

生产依赖固定为 PDFKit `0.20.2`、fontkit `2.0.4`、yazl `3.3.1`，精确完整性与许可证记入根目录 npm 清单。

字体为 `notofonts/noto-cjk` 提交 `523d033d6cb47f4a80c58a35753646f5c3608a78` 的 `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`，保留上游 OFL-1.1 原文和文件摘要。固定清单位于 `apps/host/assets/fonts/noto-sans-cjk/manifest.json`；`scripts/verify-export-font.mjs` 校验字体与许可原字节。运行时不下载字体、不复制系统字体。

macOS sidecar 包含独立导出子进程与字体/OFL 资产。`--assets-smoke` 仅验证打包后导出及提取，不启动监听端口；完整 `--smoke` 还验证 Host。

## 验证记录

- 已取得新增契约、派生来源、事务与固定成果读取的红灯，随后完成对应聚焦修复。完整测试数以阶段验证报告为准。
- 三格式实际生成后经原有文档提取器回读，核对中文、金额、特殊字符和公式样式文本。
- 实际 macOS universal sidecar 的三格式生成与独立提取自检通过；旧 PDF 提取子进程自检通过。
- PDF 经 Poppler 独立渲染，中文与 ASCII 正常；DOCX/XLSX 经 LibreOffice 转 PDF 后检查页面。首次 Office 渲染环境缺少中文字体，出现空白字形；仅为 QA 配置仓库固定字体后重新验证，未安装或复制系统字体。
- HTTP 测试使用真实 Host、SQLite、Worker、加密 Asset 和固定模型响应；不是付费模型质量评测。真实部署、完整基线与 UI/CLI 保存验收由 P5 阶段报告单独记录。
