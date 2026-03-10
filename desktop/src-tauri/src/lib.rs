use std::env;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{App, Manager};

const DOCS_URL: &str = "https://github.com/ppop123/openclaw-relay/blob/main/docs/quick-start.md";
const RELEASES_URL: &str = "https://github.com/ppop123/openclaw-relay/releases";

fn build_menu(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    let open_docs = MenuItem::with_id(app, "open_docs", "Open documentation", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for updates",
        true,
        None::<&str>,
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&open_docs, &check_updates])?;
    Menu::with_items(app, &[&help])
}

fn open_external(url: &str) {
    if let Err(error) = open::that_detached(url) {
        eprintln!("failed to open {url}: {error}");
    }
}

fn launch_args_script_for(args: &[String]) -> String {
    let serialized = serde_json::to_string(args).unwrap_or_else(|_| "[]".to_string());
    format!(
        "window.__OPENCLAW_RELAY_LAUNCH_ARGS = {serialized};window.dispatchEvent(new CustomEvent('openclaw-relay-launch-args', {{ detail: window.__OPENCLAW_RELAY_LAUNCH_ARGS }}));"
    )
}

fn initial_launch_args_script() -> String {
    let args: Vec<String> = env::args().skip(1).collect();
    launch_args_script_for(&args)
}

fn forward_launch_args(app: &tauri::AppHandle, args: &[String]) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.eval(launch_args_script_for(args));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            forward_launch_args(app, &args);
        }))
        .append_invoke_initialization_script(initial_launch_args_script())
        .setup(|app| {
            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|_app, event| match event.id().0.as_str() {
            "open_docs" => open_external(DOCS_URL),
            "check_updates" => open_external(RELEASES_URL),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenClaw Relay desktop shell");
}
