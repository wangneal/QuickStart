mod ai;
mod classifier;
mod commands;
mod db;
mod pe_utils;
mod scanner;
mod tray;
mod window_utils;

use std::sync::Mutex;
use rusqlite::Connection;
use tauri::Manager;

pub struct AppState {
    pub db_path: std::path::PathBuf,
    pub db_conn: Mutex<Connection>,
}
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};
use window_utils::{toggle_window, position_window_bottom_left};
use window_vibrancy::{apply_acrylic, apply_mica};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        // Alt+Space 切换窗口显示，定位到左下角
                        if shortcut.matches(Modifiers::ALT, Code::Space)
                        {
                            if let Some(window) = app.get_webview_window("main") {
                                toggle_window(&window);
                            }
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            // 初始化数据库
            let app_handle = app.handle().clone();
            let db_path = db::get_db_path(&app_handle);
            if let Err(e) = db::init_database(&db_path) {
                eprintln!("数据库初始化失败: {}", e);
            }

            // 创建共享数据库连接
            let conn = Connection::open(&db_path).expect("打开数据库失败");

            // 托管 AppState 供 commands 使用
            app.manage(AppState {
                db_path,
                db_conn: Mutex::new(conn),
            });

            // 注册全局快捷键 Alt+Space
            app.global_shortcut()
                .register(tauri_plugin_global_shortcut::Shortcut::new(
                    Some(Modifiers::ALT),
                    Code::Space,
                ))?;

            // 设置系统托盘
            tray::create_tray(app)?;

            // 自动启动时隐藏窗口，否则定位到左下角并显示
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--autostart".to_string()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            } else if let Some(window) = app.get_webview_window("main") {
                position_window_bottom_left(&window);

                // 应用 Windows 毛玻璃效果 (Win11 Mica, Win10 Acrylic)
                #[cfg(target_os = "windows")]
                {
                    // 先尝试 Mica (Win11)，失败则使用 Acrylic (Win10)
                    // ARGB: alpha=0x99 (60%), R=0x00, G=0x00, B=0x00 (半透明黑色)
                    if apply_mica(&window, None).is_err() {
                        let _ = apply_acrylic(&window, Some((0x99, 0x00, 0x00, 0x00)));
                    }
                }

                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_list,
            commands::get_categories,
            commands::add_category,
            commands::add_app,
            commands::remove_app,
            commands::update_app_category,
            commands::toggle_pin_app,
            commands::record_app_launch,
            commands::scan_apps,
commands::get_folder_list,
            commands::add_folder,
            commands::remove_folder,
            commands::get_folder_categories,
            commands::add_folder_category,
            commands::update_folder_category,
            commands::get_db_path,
            commands::get_app_icon,
            commands::classify_uncategorized,
            commands::get_setting,
            commands::set_setting,
            commands::refresh_app_icon,
            commands::search_files,
            commands::check_update,
            commands::launch_app,
            commands::reveal_in_explorer,
            commands::get_last_scan_time,
            commands::record_search,
            commands::get_search_history,
            commands::clear_search_history,
            ai::ai_chat_stream,
            ai::list_directory,
            ai::ai_get_apps,
            ai::ai_classify_apps,
            ai::organize_folder,
        ])
        .run(tauri::generate_context!())
        .expect("启动 QuickStart 时出错");
}
