# Desktop Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap the existing OpenClaw Relay web client in a Tauri v2 desktop shell with system tray, notifications, connection status, and update checking.

**Architecture:** `desktop/src-tauri/` contains a minimal Rust backend that loads `client/index.html` via Tauri's asset protocol. The web client gets a few lines of progressive-enhancement bridge code (`window.__TAURI__` detection) for notifications, connection state sync, and update checking. Zero changes to the web client's existing behavior in browsers.

**Tech Stack:** Tauri v2, Rust, tauri-plugin-opener, tauri-plugin-notification, vanilla JS (existing client)

---

### Task 1: Scaffold Tauri v2 Project

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/src-tauri/Cargo.toml`
- Create: `desktop/src-tauri/build.rs`
- Create: `desktop/src-tauri/src/main.rs`
- Create: `desktop/src-tauri/src/lib.rs`

**Step 1: Create `desktop/package.json`**

```json
{
  "name": "openclaw-relay-desktop",
  "version": "0.5.0",
  "private": true,
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

**Step 2: Create `desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "openclaw-relay-desktop"
version = "0.5.0"
edition = "2021"

[lib]
name = "openclaw_relay_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-opener = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**Step 3: Create `desktop/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

**Step 4: Create `desktop/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openclaw_relay_desktop_lib::run()
}
```

**Step 5: Create `desktop/src-tauri/src/lib.rs`** (minimal — just loads the window)

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 6: Run npm install and verify Rust compiles**

```bash
cd /Users/wangyan/openclaw-relay/desktop && npm install
```

Expected: `node_modules/` created with `@tauri-apps/cli`.

**Step 7: Commit**

```bash
git add desktop/package.json desktop/src-tauri/
git commit -m "feat(desktop): scaffold Tauri v2 project structure"
```

---

### Task 2: Tauri Configuration

**Files:**
- Create: `desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src-tauri/capabilities/default.json`

**Step 1: Create `desktop/src-tauri/tauri.conf.json`**

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

**Step 2: Create `desktop/src-tauri/capabilities/default.json`**

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

**Step 3: Commit**

```bash
git add desktop/src-tauri/tauri.conf.json desktop/src-tauri/capabilities/
git commit -m "feat(desktop): add Tauri config and capability permissions"
```

---

### Task 3: Generate App Icons

Tauri needs specific icon sizes. We generate them from a 1024×1024 source PNG plus a grayscale variant for the "disconnected" tray state.

**Files:**
- Create: `desktop/src-tauri/icons/icon.png` (1024×1024 source)
- Create: `desktop/src-tauri/icons/icon-gray.png` (grayscale variant)
- Create: `desktop/src-tauri/icons/32x32.png`
- Create: `desktop/src-tauri/icons/128x128.png`
- Create: `desktop/src-tauri/icons/128x128@2x.png`
- Create: `desktop/src-tauri/icons/icon.icns`
- Create: `desktop/src-tauri/icons/icon.ico`

**Step 1: Generate a source icon**

Use the AI image generation script to create a 1024×1024 app icon. The icon should represent a relay/connection concept (e.g., a stylized signal/link icon) with the OpenClaw brand colors.

```bash
python3 ~/.openclaw/workspace/skills/generate-image/generate_image.py \
  --prompt "App icon for OpenClaw Relay, a secure communication relay app. Simple geometric design with a stylized signal/connection symbol, dark blue and teal gradient background, clean modern flat design, suitable for macOS and Windows app icon, 1024x1024" \
  --output /Users/wangyan/openclaw-relay/desktop/src-tauri/icons/icon.png \
  --size 1024x1024
```

If the script isn't available or fails, use any existing project logo, or create a placeholder:

```bash
mkdir -p /Users/wangyan/openclaw-relay/desktop/src-tauri/icons
# Fallback: use Tauri's default icons temporarily
cd /Users/wangyan/openclaw-relay/desktop && npx tauri icon
```

**Step 2: Generate all icon sizes with `cargo tauri icon`**

```bash
cd /Users/wangyan/openclaw-relay/desktop
npx tauri icon src-tauri/icons/icon.png
```

This generates: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` — all placed in `src-tauri/icons/`.

**Step 3: Create the grayscale "disconnected" tray icon**

Use ImageMagick (or sips on macOS) to create a desaturated version:

```bash
# macOS with sips:
cp desktop/src-tauri/icons/icon.png /tmp/icon-source.png
sips -s format png --setProperty formatOptions 100 /tmp/icon-source.png

# With ImageMagick (if available):
convert desktop/src-tauri/icons/icon.png -colorspace Gray desktop/src-tauri/icons/icon-gray.png

# Fallback — Python one-liner:
python3 -c "
from PIL import Image
img = Image.open('desktop/src-tauri/icons/icon.png').convert('LA').convert('RGBA')
img.save('desktop/src-tauri/icons/icon-gray.png')
"
```

If none of these tools are available, just copy icon.png as icon-gray.png for now (the feature still works, just both states look the same — purely cosmetic).

**Step 4: Verify all required icon files exist**

```bash
ls -la desktop/src-tauri/icons/
```

Expected files: `icon.png`, `icon-gray.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`

**Step 5: Commit**

```bash
git add desktop/src-tauri/icons/
git commit -m "feat(desktop): add app icons and grayscale tray variant"
```

---

### Task 4: Implement Tray + Window Lifecycle (lib.rs)

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

**Step 1: Write the full `lib.rs`**

Replace the minimal lib.rs from Task 1 with the complete implementation:

```rust
use tauri::{
    Emitter, Manager,
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const RELEASES_URL: &str = "https://github.com/nicepkg/openclaw-relay/releases";

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
            app.listen("relay-connection-state", move |event| {
                let connected = event.payload() == "\"connected\"";
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

**Step 2: Verify Rust compiles**

```bash
cd /Users/wangyan/openclaw-relay/desktop && cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: compiles with 0 errors. Warnings about unused variables are OK.

**Step 3: Commit**

```bash
git add desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): implement tray menu, hide-to-tray, connection state, and notifications"
```

---

### Task 5: Add Tauri Bridge to Web Client

This is the progressive-enhancement layer. All code is guarded by `if (!window.__TAURI__) return;` — zero impact in browsers.

**Files:**
- Modify: `client/js/app.js`

**Step 1: Read current `client/js/app.js`**

Read the full file to find the exact insertion points.

**Step 2: Add bridge functions near the top of `app.js`**

After the existing imports/constants at the top of `app.js`, add:

```javascript
// --- Tauri desktop bridge (progressive enhancement) ---
// These functions are no-ops when running in a browser.
// In the Tauri desktop shell, window.__TAURI__ is available.
const _tauri = window.__TAURI__;

function notifyDesktop(title, body) {
  if (!_tauri) return;
  _tauri.event.emit('relay-notify', { title, body });
}

function syncConnectionState(state) {
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

**Step 3: Wire `syncConnectionState` into `_updateStatus()`**

Find the `_updateStatus(state)` method in the `app` object. It handles the `onStateChange` callback from the transport layer. Add a single line at the top of this method:

```javascript
_updateStatus(state) {
  syncConnectionState(state === 'connected' ? 'connected' : 'disconnected');  // ← ADD THIS LINE
  // ... existing code unchanged ...
}
```

**Step 4: Wire `notifyDesktop` into streaming message completion**

Find where assistant messages finish streaming. This is in the `handleSend()` method, in the stream completion handler (the callback that runs after streaming ends and the final response arrives). After the message is added to the chat, add:

```javascript
// After the assistant message is finalized and rendered:
if (document.hidden) {
  notifyDesktop('OpenClaw', '收到新消息');
}
```

**Step 5: Wire `checkForUpdates` into `init()`**

At the end of the `init()` method, add:

```javascript
async init() {
  // ... existing init code ...

  checkForUpdates();  // ← ADD THIS LINE (last line of init)
}
```

**Step 6: Run existing web client tests to verify no regressions**

```bash
cd /Users/wangyan/openclaw-relay/client && npm test
```

Expected: All tests pass. The bridge code is guarded by `if (!_tauri)` so it's a no-op in the test environment.

**Step 7: Commit**

```bash
git add client/js/app.js
git commit -m "feat(client): add Tauri desktop bridge (progressive enhancement, no-op in browser)"
```

---

### Task 6: Build and Verify Locally

**Step 1: Run Tauri dev mode**

```bash
cd /Users/wangyan/openclaw-relay/desktop && npx tauri dev
```

Expected: A native window opens showing the OpenClaw Relay connect panel. The web client loads identically to the browser version.

**Step 2: Verify tray icon appears**

- macOS: Check menu bar for the tray icon
- The tray icon should appear when the app starts

**Step 3: Verify hide-to-tray**

- Click the window close button (×)
- Expected: Window disappears, tray icon remains
- Click tray icon → window reappears

**Step 4: Verify tray right-click menu**

- Right-click tray icon
- Expected: Menu shows "显示", "检查更新", "退出"
- Click "检查更新" → default browser opens GitHub releases page
- Click "退出" → app quits completely

**Step 5: Verify connection and notifications (requires a running relay)**

If a relay is available for testing:
- Connect to it via the UI
- Verify tray icon changes to indicate "connected" state
- Minimize/hide window, send a message, verify OS notification appears
- Click notification → window shows

**Step 6: Run production build**

```bash
cd /Users/wangyan/openclaw-relay/desktop && npx tauri build
```

Expected: Produces a `.dmg` on macOS or `.exe` on Windows in `src-tauri/target/release/bundle/`.

**Step 7: Commit any fixes discovered during testing**

```bash
git add -A desktop/ client/
git commit -m "fix(desktop): adjustments from local testing"
```

---

### Task 7: Add CI Workflow

**Files:**
- Create: `.github/workflows/desktop.yml`

**Step 1: Create the workflow file**

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

**Step 2: Commit**

```bash
git add .github/workflows/desktop.yml
git commit -m "ci(desktop): add GitHub Actions workflow for desktop release builds"
```

---

### Task 8: Add `desktop/` to `.gitignore` and Documentation

**Files:**
- Modify: `.gitignore` (add desktop build artifacts)
- Create: `desktop/README.md`

**Step 1: Add desktop build artifacts to `.gitignore`**

Append to the project root `.gitignore`:

```
# Desktop shell build artifacts
desktop/node_modules/
desktop/src-tauri/target/
```

**Step 2: Create `desktop/README.md`**

```markdown
# OpenClaw Relay Desktop

[中文](#中文) | [English](#english)

---

## 中文

OpenClaw Relay 的桌面客户端。将浏览器版封装为原生应用，提供系统托盘、消息通知和自动更新检查。

### 安装

从 [GitHub Releases](https://github.com/nicepkg/openclaw-relay/releases) 下载对应平台的安装包：

- **macOS**: `OpenClaw-Relay_x.y.z_aarch64.dmg`（Apple Silicon）或 `_x64.dmg`（Intel）
- **Windows**: `OpenClaw-Relay_x.y.z_x64-setup.exe`

### 开发

```bash
# 安装依赖
npm ci

# 开发模式（热重载）
npx tauri dev

# 生产构建
npx tauri build
```

### 运行时要求

- macOS 10.15+ 或 Windows 10+
- Windows 需要 WebView2（安装程序会自动处理）

---

## English

Desktop client for OpenClaw Relay. Wraps the browser version as a native app with system tray, message notifications, and update checking.

### Install

Download from [GitHub Releases](https://github.com/nicepkg/openclaw-relay/releases):

- **macOS**: `OpenClaw-Relay_x.y.z_aarch64.dmg` (Apple Silicon) or `_x64.dmg` (Intel)
- **Windows**: `OpenClaw-Relay_x.y.z_x64-setup.exe`

### Development

```bash
# Install dependencies
npm ci

# Dev mode (hot reload)
npx tauri dev

# Production build
npx tauri build
```

### Requirements

- macOS 10.15+ or Windows 10+
- Windows requires WebView2 (installer handles this automatically)
```

**Step 3: Commit**

```bash
git add .gitignore desktop/README.md
git commit -m "docs(desktop): add README and gitignore for build artifacts"
```

---

### Task 9: Final Verification

**Step 1: Run web client tests (regression check)**

```bash
cd /Users/wangyan/openclaw-relay/client && npm test
```

Expected: All tests pass. The Tauri bridge code is behind `if (!_tauri)` guards.

**Step 2: Run Tauri dev mode one more time**

```bash
cd /Users/wangyan/openclaw-relay/desktop && npx tauri dev
```

Verify:
1. Window opens with correct title "OpenClaw Relay"
2. Window size is ~480×720, resizable, centered
3. Tray icon appears
4. Close (×) hides to tray
5. Left-click tray → show window
6. Right-click tray → menu: 显示 / 检查更新 / 退出
7. "检查更新" opens browser to releases page
8. "退出" quits the app
9. Web client UI loads correctly (connect panel visible)

**Step 3: Run production build**

```bash
cd /Users/wangyan/openclaw-relay/desktop && npx tauri build
```

Expected: Build completes, installer in `src-tauri/target/release/bundle/`.

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(desktop): final adjustments from verification"
```

---

## Task Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Scaffold Tauri v2 project | `desktop/package.json`, `Cargo.toml`, `main.rs`, `lib.rs` |
| 2 | Tauri config + capabilities | `tauri.conf.json`, `capabilities/default.json` |
| 3 | Generate app icons | `desktop/src-tauri/icons/*` |
| 4 | Tray + window lifecycle + events | `desktop/src-tauri/src/lib.rs` |
| 5 | Tauri bridge in web client | `client/js/app.js` |
| 6 | Build and verify locally | Manual testing |
| 7 | CI workflow | `.github/workflows/desktop.yml` |
| 8 | Gitignore + README | `.gitignore`, `desktop/README.md` |
| 9 | Final verification | Run tests + build |

## Prerequisites

- Rust toolchain installed (`rustup`)
- Node.js 22+
- Tauri v2 system dependencies:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools + WebView2
  - See https://v2.tauri.app/start/prerequisites/
