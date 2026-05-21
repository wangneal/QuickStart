use std::fs;

use crate::classifier::Classifier;
use crate::scanner;
use super::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppData {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub icon_path: Option<String>,
    pub category: String,
    pub use_count: i64,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderItem {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub sort_order: i64,
}

/// 获取分类列表（用于面板）
#[tauri::command]
pub fn get_categories(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT name FROM categories WHERE TRIM(name) <> '' ORDER BY sort_order ASC, name ASC",
        )
        .map_err(|e| e.to_string())?;

    let cats = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(cats)
}

/// 新建分类（支持空分类）
#[tauri::command]
pub fn add_category(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let category = name.trim().to_string();
    if category.is_empty() {
        return Err("分类名称不能为空".to_string());
    }
    if category == "全部" {
        return Err("不能使用保留分类名称".to_string());
    }

    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM categories WHERE name = ?1",
            [&category],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if exists {
        return Err("分类已存在".to_string());
    }

    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO categories (name, sort_order) VALUES (?1, ?2)",
        rusqlite::params![category, next_order],
    )
    .map_err(|e| e.to_string())?;

    Ok(category)
}

/// 添加应用
#[tauri::command]
pub fn add_app(
    state: State<'_, AppState>,
    name: String,
    path: String,
    icon_path: Option<String>,
    category: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<AppData, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let cat = category.unwrap_or_else(|| "未分类".to_string());

    // 检查是否已存在
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM apps WHERE LOWER(path) = ?1",
            [&path.to_lowercase()],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if exists {
        return Err("该应用已存在".to_string());
    }

    // 提取图标
    let icon = icon_path.or_else(|| scanner::extract_and_cache_icon(&path, &app_handle));

    // 同步分类到 categories 表（避免分类不一致）
    conn.execute(
        "INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
        [&cat],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO apps (name, path, icon_path, category) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, path, icon, cat],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    Ok(AppData {
        id,
        name,
        path,
        icon_path: icon,
        category: cat,
        use_count: 0,
        is_pinned: false,
    })
}

/// 删除应用
#[tauri::command]
pub fn remove_app(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM apps WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 更新应用分类
#[tauri::command]
pub fn update_app_category(
    state: State<'_, AppState>,
    id: i64,
    category: String,
) -> Result<(), String> {
    let category = category.trim().to_string();
    if category.is_empty() {
        return Err("分类名称不能为空".to_string());
    }
    if category == "全部" {
        return Err("不能使用保留分类名称".to_string());
    }

    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;

    // 事务保护：INSERT + UPDATE 在同一事务中，避免 sort_order 子查询竞态
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR IGNORE INTO categories (name, sort_order)
         VALUES (?1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
        [&category],
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        e.to_string()
    })?;

    conn.execute(
        "UPDATE apps SET category = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        rusqlite::params![category, id],
    )
    .map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK");
        e.to_string()
    })?;

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    Ok(())
}

/// 切换固定状态
#[tauri::command]
pub fn toggle_pin_app(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let current: bool = conn
        .query_row(
            "SELECT is_pinned FROM apps WHERE id = ?1",
            [id],
            |row| row.get::<_, i64>(0).map(|v| v != 0),
        )
        .map_err(|e| e.to_string())?;

    let new_val = if current { 0 } else { 1 };
    conn.execute(
        "UPDATE apps SET is_pinned = ?1 WHERE id = ?2",
        rusqlite::params![new_val, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(!current)
}

/// 记录应用使用（增加使用频率）
#[tauri::command]
pub fn record_app_launch(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE apps SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 触发全量扫描（异步，不阻塞 UI）
#[tauri::command]
pub async fn scan_apps(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<scanner::ScanResult, String> {
    let path = state.db_path.to_string_lossy().to_string();
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        let result = scanner::scan_and_save(&conn, &handle)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params!["last_scan_time", &now.to_string()],
        ).map_err(|e| e.to_string())?;
        let _ = handle.emit("scan-complete", result.clone());
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

/// 获取文件夹列表
#[tauri::command]
pub fn get_folder_list(state: State<'_, AppState>) -> Result<Vec<FolderItem>, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, path, sort_order FROM folders ORDER BY sort_order ASC, name ASC")
        .map_err(|e| e.to_string())?;

    let folders = stmt
        .query_map([], |row| {
            Ok(FolderItem {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                sort_order: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(folders)
}

/// 添加文件夹
#[tauri::command]
pub fn add_folder(
    state: State<'_, AppState>,
    name: String,
    path: String,
) -> Result<FolderItem, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;

    // 获取最大排序值
    let max_order: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), 0) FROM folders", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO folders (name, path, sort_order) VALUES (?1, ?2, ?3)",
        rusqlite::params![name, path, max_order + 1],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    Ok(FolderItem {
        id,
        name,
        path,
        sort_order: max_order + 1,
    })
}

/// 删除文件夹
#[tauri::command]
pub fn remove_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取应用图标（按需提取+缓存，返回 base64 data URL）
#[tauri::command]
pub async fn get_app_icon(
    state: State<'_, AppState>,
    app_id: i64,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let db = state.db_path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = Connection::open(&db).map_err(|e| e.to_string())?;
        let app_path: String = conn
            .query_row("SELECT path FROM apps WHERE id = ?1", [app_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let icon_path: Option<String> = conn
            .query_row("SELECT icon_path FROM apps WHERE id = ?1", [app_id], |row| row.get(0))
            .ok();

        if let Some(path) = icon_path.as_deref() {
            if path == "__failed__" {
                return Ok(String::new());
            }
            if !path.is_empty() && std::path::Path::new(path).exists() {
                if let Ok(data) = fs::read(path) {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                    return Ok(format!("data:image/png;base64,{}", b64));
                }
            }
        }

        if let Some(cached) = scanner::extract_and_cache_icon(&app_path, &app_handle) {
            let _ = conn.execute(
                "UPDATE apps SET icon_path = ?1 WHERE id = ?2",
                rusqlite::params![cached, app_id],
            );
            if let Ok(data) = fs::read(&cached) {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                return Ok(format!("data:image/png;base64,{}", b64));
            }
        }

        let _ = conn.execute("UPDATE apps SET icon_path = '__failed__' WHERE id = ?1", [app_id]);
        Ok(String::new())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 自动分类未归类应用（检查设置开关）
#[tauri::command]
pub fn classify_uncategorized(state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;

    // 检查是否启用自动分类
    let enabled: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'auto_classify'", [], |row| row.get(0))
        .unwrap_or_else(|_| "true".into());
    if enabled != "true" {
        return Ok(0);
    }

    let classifier = Classifier::new();
    classifier.classify_uncategorized(&conn).map_err(|e| e.to_string())
}

/// 获取数据库路径
#[tauri::command]
pub fn get_db_path(state: State<'_, AppState>) -> String {
    state.db_path.to_string_lossy().to_string()
}

/// 获取设置
#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> Result<String, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// 更新设置
#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 刷新单个应用图标
#[tauri::command]
pub fn refresh_app_icon(
    state: State<'_, AppState>,
    id: i64,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;

    let app_path: String = conn
        .query_row("SELECT path FROM apps WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;

    let icon_path = scanner::extract_and_cache_icon(&app_path, &app_handle);

    if let Some(ref icon) = icon_path {
        conn.execute(
            "UPDATE apps SET icon_path = ?1 WHERE id = ?2",
            rusqlite::params![icon, id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(icon_path)
}

/// 搜索文件（桌面/下载/文档目录）
#[derive(Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn search_files(query: String) -> Result<Vec<FileResult>, String> {
    let user = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Default".into());
    let dirs = [
        PathBuf::from(&user).join("Desktop"),
        PathBuf::from(&user).join("Downloads"),
        PathBuf::from(&user).join("Documents"),
    ];

    let q = query.to_lowercase();
    let mut results = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for dir in &dirs {
        if !dir.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini") { continue; }
                let lower = name.to_lowercase();
                if lower.contains(&q) && seen.insert(lower) {
                    results.push(FileResult {
                        name,
                        path: path.to_string_lossy().to_string(),
                        is_dir: path.is_dir(),
                    });
                }
                if results.len() >= 20 { break; }
            }
        }
        if results.len() >= 20 { break; }
    }

    Ok(results)
}

/// 检查 GitHub 最新版本
#[tauri::command]
pub async fn check_update() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build().map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.github.com/repos/wangneal/QuickStart/releases/latest")
        .header("User-Agent", "QuickStart")
        .header("Accept", "application/vnd.github.v3+json")
        .send().await.map_err(|_| "无法连接 GitHub".to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|_| "解析响应失败".to_string())?;
    let tag = json["tag_name"].as_str().unwrap_or("").to_string();
    if tag.is_empty() { return Err("获取版本失败".into()); }
    Ok(tag)
}

/// 启动应用（支持 lnk/exe/URL/任意关联文件）
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("启动失败: {}", e))?;
    Ok(())
}

/// 在资源管理器中定位文件（explorer /select,）
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let abs = std::path::Path::new(&path);
    if !abs.exists() { return Err("文件不存在".into()); }
    std::process::Command::new("explorer")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    Ok(())
}

/// 获取应用列表
#[tauri::command]
pub fn get_app_list(state: State<'_, AppState>) -> Result<Vec<AppData>, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, path, icon_path, category, use_count, is_pinned FROM apps ORDER BY is_pinned DESC, use_count DESC, name ASC")
        .map_err(|e| e.to_string())?;

    let apps = stmt
        .query_map([], |row| {
            Ok(AppData {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                icon_path: row.get(3)?,
                category: row.get(4)?,
                use_count: row.get(5)?,
                is_pinned: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(apps)
}

/// 获取上次扫描时间（Unix 秒字符串）
#[tauri::command]
pub fn get_last_scan_time(state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'last_scan_time'",
        [],
        |row| row.get::<_, String>(0),
    ).map_err(|e| e.to_string())
}

/// 记录搜索历史
#[tauri::command]
pub fn record_search(state: State<'_, AppState>, query: String) -> Result<(), String> {
    let q = query.trim().to_string();
    if q.is_empty() { return Ok(()); }
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    // 去重：如果已有相同 query，更新时间戳而非重复插入
    conn.execute(
        "INSERT INTO search_history (query) VALUES (?1)",
        [&q],
    ).map_err(|e| e.to_string())?;
    // 保留最近 100 条，删除更早的
    conn.execute(
        "DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY searched_at DESC LIMIT 100)",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取搜索历史（按时间倒序，去重）
#[tauri::command]
pub fn get_search_history(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT query FROM search_history GROUP BY query ORDER BY MAX(searched_at) DESC LIMIT 20")
        .map_err(|e| e.to_string())?;
    let history = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(history)
}

/// 清空搜索历史
#[tauri::command]
pub fn clear_search_history(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM search_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
