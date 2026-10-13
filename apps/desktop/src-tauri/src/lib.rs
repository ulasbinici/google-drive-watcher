use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

const BROWSER_LABEL: &str = "browser";

struct TrayStatus {
    icon: tauri::tray::TrayIcon,
    label: tauri::menu::MenuItem<tauri::Wry>,
}

fn clip(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end < text.len() {
        format!("{}…", &text[..end.saturating_sub(1)])
    } else {
        text.to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalEntry {
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

#[tauri::command]
fn write_file(request: Request<'_>) -> Result<u64, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected file bytes".into());
    };
    let path = PathBuf::from(percent_decode(
        header(&request, "x-path").ok_or("Missing destination path")?,
    )?);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())?;
    if let Some(modified) = header(&request, "x-modified").and_then(|v| v.parse::<u64>().ok()) {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.set_modified(UNIX_EPOCH + Duration::from_millis(modified))
            .map_err(|e| e.to_string())?;
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(meta.modified().map(millis).unwrap_or(0))
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn scan(root: &Path, dir: &Path, out: &mut Vec<LocalEntry>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let relative = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        out.push(LocalEntry {
            path: relative,
            is_dir: kind.is_dir(),
            size: if kind.is_dir() { 0 } else { meta.len() },
            modified: meta.modified().map(millis).unwrap_or(0),
        });
        if kind.is_dir() {
            scan(root, &path, out)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn scan_dir(path: String) -> Result<Vec<LocalEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Folder not found: {path}"));
    }
    let mut out = Vec::new();
    scan(&root, &root, &mut out)?;
    Ok(out)
}

#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let status = app.state::<TrayStatus>();
    let menu = clip(&text, 110);
    let tip = clip(&text, 120);
    status.label.set_text(&menu).map_err(|e| e.to_string())?;
    status
        .icon
        .set_tooltip(Some(&tip))
        .map_err(|e| e.to_string())
}

// Must be async: on Windows, building a webview inside a sync command deadlocks and leaves it blank.
#[tauri::command]
async fn open_browser(app: tauri::AppHandle) -> Result<(), String> {
    show_browser(&app)
}

fn show_browser(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(BROWSER_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    // Load the app shell. A path like "browse" is served as HTML without an .html
    // name, and WebView2 leaves that window blank and unable to close.
    WebviewWindowBuilder::new(app, BROWSER_LABEL, WebviewUrl::App("index.html".into()))
        .title("Drive Watch – Browse")
        .inner_size(1240.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .initialization_script("window.__DRIVE_WATCH_WINDOW__ = 'browser'")
        .disable_drag_drop_handler()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            write_file,
            read_file,
            make_dir,
            path_exists,
            scan_dir,
            open_browser,
            set_tray_status
        ])
        .setup(|app| {
            let sync_status =
                MenuItem::with_id(app, "sync-status", "Sync: idle", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open Drive Watch", true, None::<&str>)?;
            let browse = MenuItem::with_id(app, "browse", "Browse Drive", true, None::<&str>)?;
            let pause =
                MenuItem::with_id(app, "toggle-monitoring", "Pause monitoring", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&sync_status, &show, &browse, &pause, &quit])?;

            let icon = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("application icon"))
                .tooltip("Drive Watch")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "browse" => {
                        let _ = show_browser(app);
                    }
                    "toggle-monitoring" => {
                        let _ = app.emit("tray-toggle-monitoring", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.manage(TrayStatus {
                icon,
                label: sync_status,
            });

            #[cfg(desktop)]
            app.deep_link().register_all()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    let _ = window.hide();
                } else {
                    let _ = window.destroy();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
