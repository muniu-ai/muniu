# 企业测试依赖

`minio.Dockerfile` 为 Compose 和 Kind 构建本地 `mn-minio-fixture:2025-04` 镜像，包含原测试版本的 MinIO Server 与 mc。镜像仅用于一次性集成测试，不是生产对象存储推荐。构建流程不向外部仓库推送镜像。

## 来源与校验

2026-09-28 核验时，Docker Hub 和 Quay 的 `minio/minio`、`minio/mc` 均拒绝匿名读取 manifest，`dl.min.io` 对原版本的下载校验文件返回 `410 Gone`。这不能解释为某个新镜像地址已经可用。MinIO [官方仓库](https://github.com/minio/minio)已声明社区版仅分发源码、旧二进制不再维护，仓库也已归档。

构建保留既有测试版本，直接读取官方 GitHub 仓库的固定提交。`ADD --checksum` 校验压缩包后才解包与编译；失败时不切换镜像源。

| 组件 | 原版本 | 源码提交 | 压缩包 SHA-256 |
| --- | --- | --- | --- |
| MinIO Server | `RELEASE.2025-04-22T22-12-26Z` | [`0d7408fc9969caf07de6a8c3a84f9fbb10a6739e`](https://github.com/minio/minio/commit/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e) | `7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5` |
| mc | `RELEASE.2025-04-16T18-13-26Z` | [`b00526b153a31b36767991a4f5ce2cced435ee8e`](https://github.com/minio/mc/commit/b00526b153a31b36767991a4f5ce2cced435ee8e) | `4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae` |

官方 release tag 的目标提交已通过 GitHub API 核对；完整下载压缩包后，按原始字节计算校验值。Go `1.24.2-bookworm` 与 BusyBox `1.37.0` 使用 Dockerfile 中固定的多架构 index 摘要，均包含 `linux/amd64` 和 `linux/arm64`。

Go 依赖由对应源码的 `go.mod`、`go.sum` 校验，构建使用 `GOTOOLCHAIN=local`、`CGO_ENABLED=0` 和 `-mod=readonly`。镜像保留两份上游许可证，位置为 `/usr/share/licenses/minio/LICENSE` 和 `/usr/share/licenses/mc/LICENSE`。源码仍遵循各自的上游许可证；Dockerfile 的 Apache-2.0 声明不改变它们的许可。

## 构建和使用

Compose 的 `minio` 与 `minio-init` 均从同一 Dockerfile 构建；Kind 在导入依赖前构建相同镜像，并设置 `imagePullPolicy: Never`。Kind 缺少已导入的镜像时会明确失败，不会尝试拉取名称相同的远端镜像。

独立构建命令在仓库根目录执行，需要 Docker BuildKit，以及 Docker Hub、GitHub 和 Go 模块下载网络：

```bash
docker build --file deploy/fixtures/minio.Dockerfile \
  --tag mn-minio-fixture:2025-04 deploy/fixtures
```

首次构建会编译两个 Go 程序，耗时与资源需求高于拉取预编译镜像。配置回归测试只验证来源固定、Compose/Kind 一致性及导入规则；真正的构建、健康检查、S3 行为和恢复仍需完整企业与 Kind 验证。

更新版本时同时核验 release 对应提交、压缩包 SHA-256、构建工具链和两个平台的基础镜像。不得通过删除校验值或换用第三方重打包镜像处理下载失败。
