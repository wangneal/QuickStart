mod ai;
mod classifier;
mod commands;
mod db;
mod scanner;
mod tray;

use commands::DbPath;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        // Alt+Space 切换窗口显示
                        if shortcut.matches(Modifiers::ALT, Code::Space)
                        {
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
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

            // 托管 DbPath 供 commands 使用
            app.manage(DbPath(db_path));

            // 注册全局快捷键 Alt+Space
            app.global_shortcut()
                .register(tauri_plugin_global_shortcut::Shortcut::new(
                    Some(Modifiers::ALT),
                    Code::Space,
                ))?;

            // 设置系统托盘
            tray::create_tray(app)?;

            // 如果通过 autostart 启动，窗口默认隐藏
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--autostart".to_string()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_list,
            commands::get_categories,
            commands::add_app,
            commands::remove_app,
            commands::update_app_category,
            commands::toggle_pin_app,
            commands::record_app_launch,
            commands::scan_apps,
            commands::get_folder_list,
            commands::add_folder,
            commands::remove_folder,
            commands::get_db_path,
            commands::get_app_icon,
            commands::classify_uncategorized,
            commands::refresh_app_icon,
            ai::ai_chat_stream,
            ai::list_directory,
            ai::ai_get_apps,
        ])
        .run(tauri::generate_context!())
        .expect("启动 QuickStart 时出错");
}
