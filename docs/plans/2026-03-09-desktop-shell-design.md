# Desktop Shell Design

Status: revised design
Scope: `desktop/` (new directory), Tauri v2, Windows + macOS

## Core Decision

`desktop/` 不是第二条客户端产品线，也不是新的协议实现。

它是 **OpenClaw Relay 官方桌面壳**：把现有 `client/` 里的 web client 直接装进一个原生应用窗口，降低普通用户的安装和使用门槛。

这个设计只追求一件事：

> 让没有技术背景的用户也能在 Windows 和 macOS 上，下载应用、打开应用、连接自己的 OpenClaw，然后继续使用。

因此这版设计坚持三条原则：

- **单版本完成**：不靠“v1 先凑合，v1.1 再补关键体验”。第一次发出来就要能完整使用。
- **降低技术复杂度**：用户不该理解 relay、channel、gateway 这些内部术语，也不该手抄三段参数。
- **不分裂客户端行为**：桌面壳和浏览器版共享同一份前端代码、同一套安全边界、同一套连接模型。

## Product Boundary

### 官方支持面

- 官方支持的用户端包括：
  - 桌面浏览器中的 web client
  - Windows 和 macOS 上的官方桌面壳
- 官方 **不** 把手机和平板列为支持面。
  - 原因不是“暂时没做”，而是移动端后台保活和在线状态太不稳定，不适合我们要承诺的产品体验。
- Linux 用户继续使用浏览器版，不把桌面打包列为 v1 支持目标。

### 不变的安全和产品边界

桌面壳必须和现有 web client 保持同样的边界：

- 它只能连接用户自己的 OpenClaw。
- 它不能发现、联系、浏览别人的 OpenClaw。
- 它不会获得任何 peer discovery / agent-to-agent 管理能力。
- `channelToken` 仍然不持久化。
- gateway 验证仍然是 user-supplied pinned key。
- 桌面壳不新增第二套身份模型，不新增原生密钥保管逻辑，继续沿用共享前端当前的 IndexedDB / memory 行为。

## What "One-Version Complete" Means

这次不是做“技术上能跑”的桌面 demo，而是做一个可以正式交付给普通用户的桌面入口。

它完成的标志是：

1. 用户可以下载安装包。
2. 用户第一次打开时，不需要理解三个底层参数怎么填。
3. 用户可以用 **一条 pairing link** 完成接入。
4. 连接成功后，应用能像现有 web client 一样保留安全的本地状态。
5. 用户下次只需要打开应用就能继续使用。

如果做不到这 5 点，就不算“单版本完成”。

## Primary User Flow

### 首次使用

1. 用户在自己的 OpenClaw 上运行配对命令。
2. OpenClaw 输出一条 pairing link。
3. 用户在桌面客户端中：
   - 粘贴这条 pairing link，或者
   - 由系统把 pairing link 直接带进应用（如果后续实现了 launch-arg handoff）
4. 客户端自动解析 pairing link，填好连接所需信息。
5. 用户点击 `Connect`。
6. 连接成功后，页面只显示简单状态：
   - 未连接
   - 正在连接
   - 已安全连接

### 日常使用

1. 用户打开应用。
2. 应用恢复之前保存的安全设置。
3. 用户继续和自己的 OpenClaw 聊天。

这条路径里，普通用户不应该被要求手动理解：

- Relay URL
- Channel Token
- Gateway Public Key

这些信息仍然存在，但应该被折叠为“高级信息”或由 pairing link 自动带入。

## Scope for the First Official Desktop Release

### In Scope

这版桌面壳只做下面这些：

- 一个原生应用窗口
- 复用 `client/` 现有前端
- 安装包：
  - macOS `.dmg`
  - Windows NSIS installer
- 桌面端推荐的首次连接路径：
  - **pairing link**
- 明确、简单的连接状态显示
- 一个最小的帮助/更新入口
- 与浏览器版一致的安全模型

### Out of Scope

这版明确 **不做**：

- 手机 / 平板官方客户端
- Linux 桌面包
- 自动更新
- 启动时自动检查更新
- 系统托盘
- 关闭窗口后继续在后台常驻
- 桌面专属通知系统
- deep link 注册（`openclaw-relay://` 系统协议处理）
- Native secret storage / Keychain / Credential Manager 集成
- 任何 peer discovery / peer contact 用户入口

这些不是“先不做，以后肯定补”，而是为了把第一版桌面产品收得足够简单、足够稳。

## Architecture

```text
openclaw-relay/
├── client/                  # shared web client
│   ├── index.html
│   └── js/
│       └── app.js
├── desktop/                 # Tauri desktop shell
│   ├── package.json
│   ├── README.md
│   └── src-tauri/
│       ├── Cargo.toml
│       ├── build.rs
│       ├── tauri.conf.json
│       ├── icons/
│       └── src/
│           ├── main.rs
│           └── lib.rs
└── ...
```

关键决策：

- `client/` 是唯一前端真相源。
- `desktop/` 只负责原生窗口、打包和少量桌面集成。
- 不 fork `client/`，也不做第二份桌面前端。
- 允许对 `client/` 做**浏览器也安全**的共享改动，例如：
  - pairing link 解析
  - 更通俗的连接文案
  - 更简单的状态条

## UX Rules for Non-Technical Users

### Rule 1: 一个用户只该面对一条主路径

桌面版首页的主路径应当是：

- `Paste pairing link`
- `Connect`

而不是同时看到：

- Relay URL
- Channel Token
- Gateway Key
- Identity export/import
- Profiles
- 诊断信息

### Rule 2: 技术词保留，但不能挡在第一层

对于普通用户：

- 第一层应该是人话
- 第二层才是技术映射

例如：

- `Pairing link`
- `Server address`（小字再写 `Relay URL`）
- `Access token`（小字再写 `Channel token`）
- `Verification key`（小字再写 `Gateway key`）

### Rule 3: 不要让“关闭”变成魔法行为

这版桌面壳 **不做系统托盘常驻**。

理由很简单：

- 对非技术用户来说，“点了关闭却没退出”很容易造成困惑。
- 本项目当前也没有把桌面壳定义成一个后台常驻代理。
- 我们追求的是更容易打开和使用，不是更隐蔽的后台进程。

所以这版行为应当简单明确：

- 点击关闭 = 退出应用
- 需要时重新打开

### Rule 4: 更新也要低复杂度

这版不做自动更新，也不做启动时自动弹“有新版本”。

只保留一个**手动**更新入口：

- Help → Check for updates
- 打开 GitHub Release 页面

原因：

- 普通用户需要的是“知道去哪里更新”，不是理解版本探测逻辑。
- 自动探测会引入更多联网、发布流、错误处理和 UI 复杂度。
- 对一个刚起步的桌面壳来说，手动检查更新已经足够。

## Pairing Link as the Primary Onboarding Primitive

桌面壳如果继续要求用户理解三段手填参数，就不算真正降低复杂度。

所以 v1 的核心交互不是“高级连接表单”，而是 **pairing link**。

这条 pairing link 可以来自：

- `openclaw relay pair --print-web-url`
- 后续可能新增的 `--print-pairing-link`
- 任何由 OpenClaw 输出、且能被共享前端解析的 canonical pairing payload

桌面端最推荐的做法不是系统 deep link，而是：

- 应用首页提供一个 `Pairing link` 输入框
- 用户粘贴整条 link
- 前端解析后自动填入底层字段

这样做的好处：

- 浏览器版和桌面版可以共享同一套 pairing UX
- 不依赖系统协议注册
- 不引入平台差异
- 更容易测试

## Minimal Desktop Integration

这版桌面壳只需要最少的原生能力：

- 原生窗口
- 打包
- 菜单里打开外部链接（更新页 / 文档）

不需要：

- `window.__TAURI__` 作为前端主路径
- 桌面端专属通知插件
- Tray 事件桥接
- Updater runtime

如果后续确实要加这些能力，再单独评估。但第一版不以这些集成为前提。

## Tauri Configuration Direction

`desktop/src-tauri/tauri.conf.json` 应收敛成最小配置：

- `frontendDist` 指向共享的 `../../client`
- 单窗口应用
- 打包目标仅 `dmg` 和 `nsis`
- CSP 只放行现有 web client 需要的资源类型和 WebSocket 连接
- 不预设 notification / updater plugin

窗口默认建议：

- `width`: `480`
- `height`: `720`
- `minWidth`: `380`
- `minHeight`: `500`

理由：

- 更像一个专注的通信工具
- 和我们当前 web client 的单栏布局更匹配
- 对普通用户更直观

## Release Model

桌面客户端不应该有第二套版本线。

因此发布模型应当是：

- **和主项目同版本号**
- **和主项目同一个 GitHub Release 页面**
- 桌面产物只是该版本 release 的附加资产

不采用：

- `desktop-v*` 单独 tag
- 单独 desktop release 页面

理由：

- 减少对外复杂度
- 减少内部 release 流程分叉
- 避免普通用户看到两个版本体系

## Security Notes

桌面壳不能因为“更像原生应用”就突破现有边界。

必须保持：

- 只连接自己的 OpenClaw
- 不引入 peer 能力
- 不持久化 `channelToken`
- 不绕开 gateway pinned-key 验证
- 不增加“自动从某个服务拉配置”的隐式入口

## Acceptance Criteria

只有同时满足下面这些，桌面壳才算可以发布：

- macOS 和 Windows 都能产出安装包
- 安装后能正常打开主窗口
- 用户能通过 pairing link 完成首次接入
- 用户不需要手动理解三段底层参数
- 关闭应用就是退出，不产生隐藏后台状态
- 文档能用人话解释“怎么安装、怎么连接、怎么再次打开使用”
- 所有现有 human-facing client 边界保持不变

## Summary

这版桌面壳的本质不是“给极客多一个包装”，而是：

> 把已经存在的 web client 变成一个更容易被普通人安装和使用的桌面入口。

所以正确方向不是加更多桌面特性，
而是把范围收小，把体验做顺，把语言说人话。
