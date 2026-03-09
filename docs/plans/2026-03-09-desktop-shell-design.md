# Desktop Shell Design

Status: approved design
Scope: `desktop/` (new directory), Tauri v2

## Product Boundary

`desktop/` is the **official optional desktop shell** for OpenClaw Relay. It is not a new client, not a new protocol implementation, and not a fork of the web client.

It wraps the existing `client/` web client in a native window using Tauri v2's system WebView, providing:
- A native window (no browser chrome)
- System tray integration (hide to tray, show/quit)
- A "Check for updates" menu item (opens GitHub Releases page)

The web client code in `client/` is **shared** — the desktop shell loads it directly via Tauri's asset protocol. No modifications to `client/` are needed or allowed for desktop shell functionality.

## Architecture

```
openclaw-relay/
├── client/              ← shared web client (unchanged)
│   ├── index.html
│   └── js/
├── desktop/             ← new: Tauri v2 desktop shell
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

### How It Works

Tauri v2 loads `client/index.html` via the asset protocol (`tauri://localhost/`). The web client runs identically to the browser — same JS modules, same crypto, same transport. The Tauri shell adds:

1. **Native window**: No URL bar, no browser tabs. Just the app.
2. **System tray**: Window close hides to tray instead of quitting. Right-click menu: Show / Check for updates / Quit.
3. **Manual update check**: "Check for updates" opens `https://github.com/nicepkg/openclaw-relay/releases` in the default browser via the Tauri opener plugin.

### What the Shell Does NOT Do

- Does not modify `client/` code
- Does not implement any relay protocol logic
- Does not manage connections, crypto, or identity (the web client handles all of that)
- Does not have automatic update checking or background polling
- Does not show OS notifications (deferred to v1.1)

## Tauri Configuration

### `desktop/src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/nicepkg/tauri-apps/tauri-v2/crates/tauri-cli/schema.json",
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
      "csp": "default-src 'self'; connect-src wss: ws:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
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
    "opener": {}
  }
}
```

Key points:
- **`withGlobalTauri: true`**: Exposes `window.__TAURI__` so the vanilla JS client can access Tauri APIs without a bundler.
- **`frontendDist: "../../client"`**: Points to the shared web client directory.
- **`webviewInstallMode`**: On Windows, if WebView2 is not installed, the NSIS installer downloads and installs it. `silent: false` so the user sees progress.
- **`trayIcon.iconPath`**: Relative to `src-tauri/`, pointing to `icons/icon.png` which must exist.

### `desktop/src-tauri/capabilities/default.json`

Tauri v2 uses a capability-based permission system. Plugins must be explicitly allowed:

```json
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "tray:default"
  ]
}
```

Only three capabilities needed for v1:
- `core:default`: Window management
- `opener:default`: Opening URLs in default browser (for "Check for updates")
- `tray:default`: System tray icon and menu

## Rust Backend (`lib.rs`)

Minimal — just tray setup and window lifecycle:

```rust
use tauri::{
    Manager,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuItem},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Build tray menu
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let check = MenuItem::with_id(app, "check_update", "Check for updates", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &check, &quit])?;

            // Build tray icon
            TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "check_update" => {
                            let _ = tauri_plugin_opener::open_url(
                                "https://github.com/nicepkg/openclaw-relay/releases",
                                None::<&str>,
                            );
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
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

            // Hide to tray on close instead of quitting
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Window will be hidden; tray icon remains
                    // The window variable is moved into the closure
                }
            });
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## CI / Release

### GitHub Actions workflow: `.github/workflows/desktop.yml`

Triggered on git tags matching `desktop-v*`:

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

Key decisions:
- **Separate tag namespace** (`desktop-v*`): Desktop releases are independent of the relay server releases.
- **`draft: false`**: Published releases so `releases/latest` API works and users can find them.
- **No automatic update mechanism**: The "Check for updates" menu item just opens the releases page in the browser.

## v1 Scope

| Feature | v1 | v1.1 |
|---------|-----|------|
| Native window (no browser chrome) | Yes | |
| System tray icon | Yes | |
| Hide to tray on close | Yes | |
| Tray menu: Show / Check for updates / Quit | Yes | |
| Manual "Check for updates" (opens browser) | Yes | |
| macOS dmg + Windows NSIS installer | Yes | |
| macOS x64 + arm64 | Yes | |
| OS notifications on new messages | | Yes |
| Automatic update check on startup | | Yes |
| Tray icon disconnect/reconnect | | Yes |
| Linux AppImage | | Yes |

## Verification

After building, verify:

1. `npx tauri build` completes without errors on macOS and Windows
2. The app loads `client/index.html` correctly — all UI works identically to browser
3. WebSocket connections work (CSP allows `wss:` and `ws:`)
4. Close button hides window to tray (does not quit)
5. Left-click tray icon shows window
6. Right-click tray shows menu with Show / Check for updates / Quit
7. "Check for updates" opens the GitHub releases page in default browser
8. "Quit" exits the app
9. On Windows, if WebView2 is not installed, installer prompts to download it
