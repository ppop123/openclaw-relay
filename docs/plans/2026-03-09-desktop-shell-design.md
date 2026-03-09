# Desktop Shell Design

Status: approved design
Scope: `desktop/` (new directory), Tauri v2

## Product Boundary

`desktop/` is the **official桌面客户端** for OpenClaw Relay。它不是新协议实现，也不是 web client 的 fork。

它把 `client/` 下的 web client 封装在原生窗口中（通过 Tauri v2 的系统 WebView），面向**没有技术背景的普通用户**，提供：

- 原生窗口（无浏览器地址栏和标签页）
- 系统托盘（关闭窗口 → 最小化到托盘，不退出）
- 托盘连接状态指示（已连接 / 已断开）
- 窗口隐藏时收到消息弹出系统通知
- 启动时自动检查更新，有新版本时弹窗提示下载
- 双平台安装包：macOS dmg + Windows NSIS 安装程序

`client/` 代码**共享**——桌面壳通过 Tauri asset protocol 直接加载。`client/` 只需增加几行 Tauri 感知代码（检测 `window.__TAURI__`，存在时调用原生通知和状态同步，不存在时无副作用，浏览器行为不受影响）。

## Architecture

```
openclaw-relay/
├── client/              ← shared web client
│   ├── index.html
│   └── js/
│       ├── app.js       ← +几行 Tauri bridge（渐进增强，浏览器无影响）
│       └── ...
├── desktop/             ← Tauri v2 desktop shell
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── capabilities/
│   │   │   └── default.json
│   │   ├── icons/
│   │   └── src/
│   │       └── lib.rs
│   ├── package.json     ← build scripts only
│   └── README.md
```

## User Experience（面向非技术用户）

### 安装

- **macOS**: 下载 `.dmg`，拖入 Applications，完成
- **Windows**: 下载 `.exe` 安装程序，双击安装。如果系统没有 WebView2（Win10 早期版本），安装程序会自动下载安装

### 首次启动

打开应用 → 看到连接界面（和浏览器版完全一样）→ 输入 Relay 地址和配对信息 → 连接 → 开始聊天

### 日常使用

| 操作 | 行为 |
|------|------|
| 关闭窗口（×） | 窗口隐藏，应用缩到系统托盘 |
| 点击托盘图标 | 显示窗口 |
| 右键托盘 | 菜单：显示 / 检查更新 / 退出 |
| 收到消息（窗口隐藏时） | 弹出系统通知，点击通知打开窗口 |
| 托盘图标 | 已连接 = 彩色图标，已断开 = 灰色图标 |
| 启动时 | 自动检查 GitHub Releases 是否有新版本 |
| 有新版本 | 弹出对话框："发现新版本 vX.Y.Z，是否前往下载？" → 点击打开下载页 |

### 退出

右键托盘 → 退出。这是唯一的退出方式。关闭窗口只是隐藏。

## Tauri Configuration

### `desktop/src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2/crates/tauri-cli/schema.json",
  "productName": "OpenClaw Relay",
  "version": "0.5.0",
  "identifier": "com.openclaw.relay",
  "build": {
    "frontendDist": "../../client",
    "withGlobalTauri": true
  },
  "app": {
    "windows": [
      {
        "title": "OpenClaw Relay",
        "width": 480,
        "height": 720,
        "minWidth": 380,
        "minHeight": 500,
        "resizable": true,
        "center": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src wss: ws: https://api.github.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    },
    "trayIcon": {
      "iconPath": "icons/icon.png",
      "iconAsTemplate": true
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "dmg"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper",
        "silent": false
      }
    }
  },
  "plugins": {
    "opener": {},
    "notification": {
      "permissionState": "granted"
    }
  }
}
```

关键配置说明：
- **`withGlobalTauri: true`**: 让 `window.__TAURI__` 在 vanilla JS 中可用，无需打包工具
- **`frontendDist: "../../client"`**: 指向共享的 web client 目录
- **`webviewInstallMode: downloadBootstrapper`**: Windows 上 WebView2 缺失时自动下载安装
- **CSP 增加 `https://api.github.com`**: 允许检查更新 API 调用
- **`notification.permissionState: granted`**: 桌面应用默认允许通知，无需用户手动授权

### `desktop/src-tauri/capabilities/default.json`

```json
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "notification:default",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify"
  ]
}
```

四类能力：
- `core:default`: 窗口管理
- `opener:default`: 打开浏览器链接（检查更新跳转下载页）
- `notification:*`: 系统通知（收到消息时）

## Rust Backend (`lib.rs`)

```rust
use tauri::{
    Emitter, Manager,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const RELEASES_URL: &str = "https://github.com/nicepkg/openclaw-relay/releases";
const RELEASES_API: &str =
    "https://api.github.com/repos/nicepkg/openclaw-relay/releases/latest";

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_app_version])
        .setup(|app| {
            // --- Tray menu ---
            let show_i = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let update_i =
                MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &update_i, &quit_i])?;

            // --- Tray icon ---
            let tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenClaw Relay")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "check_update" => {
                        let _ = tauri_plugin_opener::open_url(RELEASES_URL, None::<&str>);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // --- Hide to tray on close ---
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }

            // --- Listen for connection state from web client ---
            let tray_handle = tray.clone();
            let app_handle = app.handle().clone();
            app.listen("relay-connection-state", move |event| {
                let connected = event.payload() == "\"connected\"";
                // Switch tray icon between color / gray
                let icon_bytes = if connected {
                    include_bytes!("../icons/icon.png").to_vec()
                } else {
                    include_bytes!("../icons/icon-gray.png").to_vec()
                };
                if let Ok(img) = Image::from_bytes(&icon_bytes) {
                    let _ = tray_handle.set_icon(Some(img));
                }
                let tooltip = if connected {
                    "OpenClaw Relay — 已连接"
                } else {
                    "OpenClaw Relay — 已断开"
                };
                let _ = tray_handle.set_tooltip(Some(tooltip));
            });

            // --- Listen for notification requests from web client ---
            let app_handle2 = app.handle().clone();
            app.listen("relay-notify", move |event| {
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let title = msg["title"].as_str().unwrap_or("OpenClaw Relay");
                    let body = msg["body"].as_str().unwrap_or("");
                    let _ = tauri_plugin_notification::NotificationBuilder::new(
                        &app_handle2, title,
                    )
                    .body(body)
                    .show();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Web Client Bridge（`client/js/app.js` 增量）

在 `client/js/app.js` 中添加渐进增强桥接。浏览器中 `window.__TAURI__` 不存在，这些代码完全不执行，零副作用。

```javascript
// --- Tauri desktop bridge (progressive enhancement) ---
const _tauri = window.__TAURI__;

function notifyDesktop(title, body) {
  // Only fires in Tauri desktop shell; no-op in browser
  if (!_tauri) return;
  _tauri.event.emit('relay-notify', { title, body });
}

function syncConnectionState(state) {
  // state: 'connected' | 'disconnected'
  if (!_tauri) return;
  _tauri.event.emit('relay-connection-state', state);
}

async function checkForUpdates() {
  if (!_tauri) return;
  try {
    const currentVersion = await _tauri.core.invoke('get_app_version');
    const resp = await fetch(
      'https://api.github.com/repos/nicepkg/openclaw-relay/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const latest = data.tag_name?.replace(/^desktop-v/, '');
    if (latest && latest !== currentVersion) {
      const yes = confirm(`发现新版本 v${latest}，是否前往下载？`);
      if (yes) {
        _tauri.opener.openUrl(data.html_url);
      }
    }
  } catch { /* silent — update check is best-effort */ }
}
```

集成点（在现有代码中添加调用）：

1. **连接成功时**: `syncConnectionState('connected')`
2. **断开时**: `syncConnectionState('disconnected')`
3. **收到助手消息且窗口不可见时**: `notifyDesktop('OpenClaw', '收到新消息')`
4. **应用启动时**: `checkForUpdates()`

窗口可见性检测用标准 `document.hidden` API。

## Icons

需要准备两套图标：

| 文件 | 用途 |
|------|------|
| `icons/icon.png` | 托盘图标（彩色，已连接） |
| `icons/icon-gray.png` | 托盘图标（灰色，已断开） |
| `icons/32x32.png` | 小尺寸图标 |
| `icons/128x128.png` | 标准图标 |
| `icons/128x128@2x.png` | Retina 图标 |
| `icons/icon.icns` | macOS 应用图标 |
| `icons/icon.ico` | Windows 应用图标 |

可使用 `cargo tauri icon <source.png>` 从一张 1024×1024 源图自动生成全部尺寸。灰色版需手动制作。

## CI / Release

### `.github/workflows/desktop.yml`

```yaml
name: Desktop Release
on:
  push:
    tags: ['desktop-v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
            label: macOS-arm64
          - os: macos-latest
            target: x86_64-apple-darwin
            label: macOS-x64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            label: Windows-x64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}
      - name: Install dependencies
        working-directory: desktop
        run: npm ci
      - name: Build
        working-directory: desktop
        run: npx tauri build --target ${{ matrix.target }}
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: desktop-${{ matrix.label }}
          path: |
            desktop/src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg
            desktop/src-tauri/target/${{ matrix.target }}/release/bundle/nsis/*.exe

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            desktop-*/**/*.dmg
            desktop-*/**/*.exe
          draft: false
          prerelease: false
```

- **独立 tag 空间** (`desktop-v*`)：桌面版发布独立于 Relay 服务端
- **`draft: false`**：正式发布，`releases/latest` API 可用于启动时检查更新

## Feature List（全部一个版本完成）

| 功能 | 说明 |
|------|------|
| 原生窗口 | 无浏览器地址栏，干净的应用体验 |
| 系统托盘 | 关闭窗口 → 缩到托盘，不退出应用 |
| 托盘状态指示 | 彩色 = 已连接，灰色 = 已断开 |
| 托盘右键菜单 | 显示 / 检查更新 / 退出 |
| 系统通知 | 窗口隐藏时收到消息弹出 OS 通知，点击打开窗口 |
| 启动更新检查 | 启动时查询 GitHub Releases API，有新版提示下载 |
| macOS 安装包 | `.dmg`，arm64 + x64 |
| Windows 安装包 | NSIS `.exe`，自动处理 WebView2 |
| GitHub Actions CI | 打 tag 自动构建发布 |

## Cargo Dependencies

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-opener = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## Verification

构建后验证清单：

1. `npx tauri build` macOS + Windows 均成功
2. 应用加载 `client/index.html`，所有 UI 功能与浏览器一致
3. WebSocket 连接正常（CSP 允许 `wss:` / `ws:`）
4. 关闭窗口 → 窗口隐藏，托盘图标仍在
5. 左键点击托盘 → 显示窗口
6. 右键托盘 → 菜单：显示 / 检查更新 / 退出
7. 连接后托盘图标变为彩色，断开后变灰
8. 窗口隐藏时收到消息 → 弹出系统通知
9. 点击通知 → 打开窗口
10. 启动时如有新版本 → 弹出提示对话框
11. "退出" → 应用完全退出
12. Windows 上 WebView2 缺失时安装程序自动处理
