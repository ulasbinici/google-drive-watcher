use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

const BROWSER_LABEL: &str = "browser";

struct TrayStatus {
    icon: tauri::tray::TrayIcon,
    label: tauri::menu::MenuItem<tauri::Wry>,
    pause: tauri::menu::MenuItem<tauri::Wry>,
    monitor: tauri::menu::MenuItem<tauri::Wry>,
    sync_now: tauri::menu::MenuItem<tauri::Wry>,
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

fn relative_under(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() {
        return None;
    }
    let parts: Vec<String> = relative
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.iter().any(|part| part == ".." || part == ".") {
        return None;
    }
    Some(parts.join("/"))
}

fn entry_at(root: &Path, relative: &str) -> Result<Option<LocalEntry>, String> {
    if relative.is_empty()
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid relative path".into());
    }
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.starts_with(root) {
        return Err("Path escapes the sync folder".into());
    }
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(None);
    }
    Ok(Some(LocalEntry {
        path: relative.to_string(),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified: meta.modified().map(millis).unwrap_or(0),
    }))
}

#[tauri::command]
fn stat_path(root: String, relative: String) -> Result<Option<LocalEntry>, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("Folder not found: {}", root.display()));
    }
    entry_at(&root, &relative)
}

fn path_under(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid relative path".into());
    }
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.starts_with(root) || path == root {
        return Err("Path escapes the sync folder".into());
    }
    Ok(path)
}

#[tauri::command]
fn remove_local(root: String, relative: String) -> Result<(), String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("Folder not found: {}", root.display()));
    }
    let path = path_under(&root, &relative)?;
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("Refusing to delete a shortcut".into());
    }
    if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[derive(Deserialize)]
struct WatchRoot {
    id: String,
    path: String,
}

#[derive(Clone, Serialize)]
struct DirtyBatch {
    id: String,
    paths: Vec<String>,
}

struct WatchHub {
    cmd: Mutex<mpsc::Sender<Vec<WatchRoot>>>,
}

fn remember_event(roots: &[WatchRoot], event: Event, pending: &mut HashMap<String, HashSet<String>>) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    for path in event.paths {
        let Some(root) = roots.iter().find(|root| path.starts_with(&root.path)) else {
            continue;
        };
        let Some(relative) = relative_under(Path::new(&root.path), &path) else {
            continue;
        };
        pending.entry(root.id.clone()).or_default().insert(relative);
    }
}

fn flush_dirty(app: &tauri::AppHandle, pending: &mut HashMap<String, HashSet<String>>) {
    for (id, paths) in pending.drain() {
        if paths.is_empty() {
            continue;
        }
        let _ = app.emit(
            "local-sync-dirty",
            DirtyBatch {
                id,
                paths: paths.into_iter().collect(),
            },
        );
    }
}

fn apply_roots(watcher: &mut RecommendedWatcher, current: &mut Vec<WatchRoot>, next: Vec<WatchRoot>) {
    for root in current.iter() {
        let _ = watcher.unwatch(Path::new(&root.path));
    }
    *current = next;
    for root in current.iter() {
        let _ = watcher.watch(Path::new(&root.path), RecursiveMode::Recursive);
    }
}

fn watch_loop(app: tauri::AppHandle, cmd_rx: mpsc::Receiver<Vec<WatchRoot>>) {
    let (event_tx, event_rx) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        if let Ok(event) = result {
            let _ = event_tx.send(event);
        }
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("local sync watcher failed to start: {error}");
            return;
        }
    };
    let mut roots = Vec::new();
    let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
    loop {
        loop {
            match cmd_rx.try_recv() {
                Ok(next) => apply_roots(&mut watcher, &mut roots, next),
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }
        match event_rx.recv_timeout(Duration::from_millis(400)) {
            Ok(event) => {
                remember_event(&roots, event, &mut pending);
                while let Ok(more) = event_rx.try_recv() {
                    remember_event(&roots, more, &mut pending);
                }
                thread::sleep(Duration::from_millis(350));
                while let Ok(more) = event_rx.try_recv() {
                    remember_event(&roots, more, &mut pending);
                }
                flush_dirty(&app, &mut pending);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn start_watch_hub(app: tauri::AppHandle) -> mpsc::Sender<Vec<WatchRoot>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || watch_loop(app, rx));
    tx
}

#[tauri::command]
fn watch_sync_roots(app: tauri::AppHandle, roots: Vec<WatchRoot>) -> Result<(), String> {
    let hub = app.state::<WatchHub>();
    hub.cmd
        .lock()
        .map_err(|e| e.to_string())?
        .send(roots)
        .map_err(|e| e.to_string())
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

#[tauri::command]
fn set_tray_controls(app: tauri::AppHandle, paused: bool, has_pairs: bool) -> Result<(), String> {
    let status = app.state::<TrayStatus>();
    status
        .pause
        .set_text(if paused { "Resume sync" } else { "Pause sync" })
        .map_err(|e| e.to_string())?;
    status
        .pause
        .set_enabled(has_pairs)
        .map_err(|e| e.to_string())?;
    status
        .sync_now
        .set_enabled(has_pairs)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_tray_monitoring(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    let status = app.state::<TrayStatus>();
    status
        .monitor
        .set_text(if paused {
            "Resume monitoring"
        } else {
            "Pause monitoring"
        })
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
            stat_path,
            remove_local,
            watch_sync_roots,
            open_browser,
            set_tray_status,
            set_tray_controls,
            set_tray_monitoring
        ])
        .setup(|app| {
            let watch_tx = start_watch_hub(app.handle().clone());
            app.manage(WatchHub {
                cmd: Mutex::new(watch_tx),
            });
            let sync_status =
                MenuItem::with_id(app, "sync-status", "Sync: idle", false, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync-now", "Sync now", false, None::<&str>)?;
            let pause = MenuItem::with_id(app, "toggle-sync", "Pause sync", false, None::<&str>)?;
            let monitor =
                MenuItem::with_id(app, "toggle-monitoring", "Pause monitoring", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Open Drive Watch", true, None::<&str>)?;
            let browse = MenuItem::with_id(app, "browse", "Browse Drive", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &sync_status,
                    &sync_now,
                    &pause,
                    &monitor,
                    &show,
                    &browse,
                    &quit,
                ],
            )?;

            let icon = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("application icon"))
                .tooltip("Drive Watch")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "browse" => {
                        let _ = show_browser(app);
                    }
                    "sync-now" => {
                        let _ = app.emit("tray-sync-now", ());
                    }
                    "toggle-sync" => {
                        let _ = app.emit("tray-toggle-sync", ());
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
                pause,
                monitor,
                sync_now,
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
