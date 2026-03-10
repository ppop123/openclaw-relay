use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::App;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
