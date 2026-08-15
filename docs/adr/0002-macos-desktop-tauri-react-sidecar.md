# ADR 0002：macOS 桌面端采用 Tauri 2、React 与本地 API

## 状态

已接受

## 背景

改造计划要求提供 macOS 桌面应用、托盘控制、轻量模式、本地诊断，以及后续的签名与公证。现有仓库已经包含 Tauri + React 基础结构。

## 决策

Mac 桌面 MVP 使用 Tauri 2 + React + TypeScript，并通过 HTTP 访问本地 Fastify API/daemon。

Keychain、进程控制和代理监管等强本地能力可以逐步下沉到 Rust command 或 sidecar，但 task/run orchestrator 继续兼容 Node worker。

## 影响

- 桌面 UI 可以增量交付，不需要替换 API/CLI/Worker 架构。
- Provider 与 proxy 状态必须通过本地 API resource 暴露。
- 产品化签名、公证和自动更新属于发布门禁，不是本地 MVP 验证的前置条件。
