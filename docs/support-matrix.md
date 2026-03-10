[中文](#中文) | [English](#english)

---

## 中文

# 支持范围与版本

> **权威来源：** [`docs/support-matrix.json`](support-matrix.json) 是机器可读的唯一数据源。本文档是其人类可读版本。

## 组件状态

### 正式支持

| 组件 | 路径 | 说明 |
|------|------|------|
| Go Relay 服务端 | `relay/` | 生产环境 Relay 实现 |
| Python SDK | `sdk/python/` | 客户端 SDK（协议层 0–2，仅客户端） |
| 浏览器参考客户端 | `client/` | 基于浏览器的参考客户端 |
| 协议规范（Protocol specification） | `protocol/` | 线协议规范（v1） |
| OpenClaw Gateway 插件 | `plugin/` | TypeScript 网关插件，用于将 Relay 支持集成到你的 OpenClaw 运行时；包含本地生命周期冒烟测试脚本 |

以上组件均在积极维护中，有 CI 测试覆盖，受 `v0.5.0` 稳定性保证约束。

### main 分支中开发中

| 组件 | 路径 | 说明 |
|------|------|------|
| Windows/macOS 桌面壳 | `desktop/` | 围绕共享浏览器前端的 Tauri 桌面壳。目标是让非技术用户通过一条 pairing link 完成安装和连接。当前在 `main` 上开发，尚未包含在 `v0.5.0` 已发布资产中。 |

### 尚未实现

| 组件 | 路径 | 状态 |
|------|------|------|
| JavaScript SDK | `sdk/js/` | 未实现 |

## 协议版本

当前唯一的协议版本为 **v1**。

- 帧（Frame）中的 `version` 字段可选。`0` 和 `1` 均视为 v1。
- 协议发生破坏性变更时会递增版本号。
- v1 实现**必须**拒绝 `version > 1` 的帧。

## 测试覆盖

| 组件 | 测试 | 框架 |
|------|------|------|
| Go Relay 服务端 | `go test` 套件 | `go test` |
| Python SDK | `pytest` 套件 | `pytest` |
| 浏览器参考客户端 | `vitest` 套件 | `vitest` |
| Windows/macOS 桌面壳（main） | `npm run build:app` | `tauri` + `cargo` |
| OpenClaw Gateway 插件 | `vitest` 套件 + 类型检查 + 本地冒烟脚本 | `vitest` + `tsc` + `bash`（插件测试需要 `PATH` 中有 `go`） |

## CI 流水线

CI 流水线执行以下检查：

| 步骤 | 命令 | 范围 | 阻断发布 |
|------|------|------|----------|
| Go 测试 | `go test` | Relay 服务端 | 是 |
| Python 测试 | `pytest` | Python SDK | 是 |
| JS 测试 | `vitest` | 浏览器客户端 | 是 |
| 插件测试 | `vitest run plugin/tests` | OpenClaw Gateway 插件 | 是 |
| 插件类型检查 | `tsc -p plugin/tsconfig.json --noEmit` | OpenClaw Gateway 插件 | 是 |
| 插件冒烟测试 | `bash scripts/smoke-openclaw-plugin.sh` | 在本地真实 OpenClaw 运行时上测试 Gateway 插件 | 否（手动/本地） |
| 文档/契约 | `validate-protocol-examples.py` + `check-doc-consistency.sh` | 协议 + 文档 | 是 |

所有正式支持的组件必须在发布前通过各自的测试套件。

---

## English

# Support Matrix and Versioning

> **Canonical source:** [`docs/support-matrix.json`](support-matrix.json) is the machine-readable single source of truth. This document mirrors it in human-readable form.

## Component Status

### Officially Supported

| Component | Path | Description |
|-----------|------|-------------|
| Go relay server | `relay/` | Production relay implementation |
| Python SDK | `sdk/python/` | Client SDK (protocol layers 0-2, client-side only) |
| Web reference client | `client/` | Browser-based reference client |
| Protocol specification | `protocol/` | Wire protocol specification (v1) |
| OpenClaw gateway plugin | `plugin/` | TypeScript gateway plugin for installing relay support into your own OpenClaw runtime; includes a local lifecycle smoke script for real-host verification |

These components are actively maintained, tested in CI, and covered by the project's stability guarantees for `v0.5.0`.

### In Progress on `main`

| Component | Path | Description |
|-----------|------|-------------|
| Windows/macOS desktop shell | `desktop/` | Thin Tauri shell around the shared browser client. It is being built on `main` for non-technical users who want a normal desktop app and a pairing-link-first connect flow. It is not part of the already released `v0.5.0` assets yet. |

### Not Yet Implemented

| Component | Path | Status |
|-----------|------|--------|
| JavaScript SDK | `sdk/js/` | Not yet implemented |

## Protocol Version

The current and only protocol version is **v1**.

- The `version` field in frames is optional. Both `0` and `1` are treated as v1.
- Breaking protocol changes will increment the version number.
- v1 implementations **MUST** reject frames with `version > 1`.

## Test Coverage

| Component | Tests | Framework |
|-----------|-------|-----------|
| Go relay server | `go test` suite | `go test` |
| Python SDK | `pytest` suite | `pytest` |
| Web reference client | `vitest` suite | `vitest` |
| Windows/macOS desktop shell (`main`) | `npm run build:app` | `tauri` + `cargo` |
| OpenClaw gateway plugin | `vitest` suite + typecheck + local smoke script | `vitest` + `tsc` + `bash` (plugin tests require `go` on `PATH`) |

## CI Pipeline

The CI pipeline runs the following checks:

| Step | Command | Scope | Blocks release |
|------|---------|-------|----------------|
| Go tests | `go test` | Relay server | Yes |
| Python tests | `pytest` | Python SDK | Yes |
| JS tests | `vitest` | Web client | Yes |
| Plugin tests | `vitest run plugin/tests` | OpenClaw gateway plugin | Yes |
| Plugin type check | `tsc -p plugin/tsconfig.json --noEmit` | OpenClaw gateway plugin | Yes |
| Plugin smoke | `bash scripts/smoke-openclaw-plugin.sh` | OpenClaw gateway plugin on a real local OpenClaw runtime | No (manual/local) |
| Docs / contracts | `validate-protocol-examples.py` + `check-doc-consistency.sh` | Protocol + docs | Yes |

All officially supported components must pass their test suites before release.
