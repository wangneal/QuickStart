use std::fs;

use crate::classifier::Classifier;
use crate::scanner;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// 数据库路径的托管状态
pub struct DbPath(pub PathBuf);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppItem {
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

/// 获取应用列表
#[tauri::command]
pub fn get_app_list(db_path: State<'_, DbPath>) -> Result<Vec<AppItem>, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, path, icon_path, category, use_count, is_pinned
             FROM apps ORDER BY is_pinned DESC, use_count DESC, name ASC",
        )
        .map_err(|e| e.to_string())?;

    let apps = stmt
        .query_map([], |row| {
            Ok(AppItem {
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

/// 获取分类列表（用于面板）
#[tauri::command]
pub fn get_categories(db_path: State<'_, DbPath>) -> Result<Vec<String>, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT DISTINCT category FROM apps ORDER BY category")
        .map_err(|e| e.to_string())?;

    let cats = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(cats)
}

/// 添加应用
#[tauri::command]
pub fn add_app(
    db_path: State<'_, DbPath>,
    name: String,
    path: String,
    icon_path: Option<String>,
    category: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<AppItem, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
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

    conn.execute(
        "INSERT INTO apps (name, path, icon_path, category) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, path, icon, cat],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    Ok(AppItem {
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
pub fn remove_app(db_path: State<'_, DbPath>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM apps WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 更新应用分类
#[tauri::command]
pub fn update_app_category(
    db_path: State<'_, DbPath>,
    id: i64,
    category: String,
) -> Result<(), String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE apps SET category = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        rusqlite::params![category, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 切换固定状态
#[tauri::command]
pub fn toggle_pin_app(db_path: State<'_, DbPath>, id: i64) -> Result<bool, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
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
pub fn record_app_launch(db_path: State<'_, DbPath>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE apps SET use_count = use_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 触发全量扫描
#[tauri::command]
pub fn scan_apps(
    db_path: State<'_, DbPath>,
    app_handle: tauri::AppHandle,
) -> Result<scanner::ScanResult, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    scanner::scan_and_save(&conn, &app_handle)
}

/// 获取文件夹列表
#[tauri::command]
pub fn get_folder_list(db_path: State<'_, DbPath>) -> Result<Vec<FolderItem>, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
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
    db_path: State<'_, DbPath>,
    name: String,
    path: String,
) -> Result<FolderItem, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;

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
pub fn remove_folder(db_path: State<'_, DbPath>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取应用图标（按需提取+缓存，返回 base64 data URL）
#[tauri::command]
pub fn get_app_icon(
    db_path: State<'_, DbPath>,
    app_id: i64,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;

    // 查出应用路径和已有 icon_path
    let (app_path, existing_icon): (String, Option<String>) = conn
        .query_row(
            "SELECT path, icon_path FROM apps WHERE id = ?1",
            [app_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // 已有缓存且文件存在，直接读取
    if let Some(ref icon) = existing_icon {
        if std::path::Path::new(icon).exists() {
            let data = fs::read(icon).map_err(|e| format!("读图标失败: {}", e))?;
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            return Ok(format!("data:image/png;base64,{}", b64));
        }
    }

    // 提取图标
    if let Some(cached) = scanner::extract_and_cache_icon(&app_path, &app_handle) {
        // 更新数据库
        let _ = conn.execute(
            "UPDATE apps SET icon_path = ?1 WHERE id = ?2",
            rusqlite::params![cached, app_id],
        );
        // 读取并返回
        if let Ok(data) = fs::read(&cached) {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            return Ok(format!("data:image/png;base64,{}", b64));
        }
    }

    Err("无法提取图标".into())
}

/// 自动分类未归类应用（检查设置开关）
#[tauri::command]
pub fn classify_uncategorized(db_path: State<'_, DbPath>) -> Result<usize, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;

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

/// 获取设置
#[tauri::command]
pub fn get_setting(db_path: State<'_, DbPath>, key: String) -> Result<String, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| row.get(0))
        .map_err(|e| e.to_string())
}

/// 更新设置
#[tauri::command]
pub fn set_setting(db_path: State<'_, DbPath>, key: String, value: String) -> Result<(), String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取数据库路径（用于前端调试）
#[tauri::command]
pub fn get_db_path(db_path: State<'_, DbPath>) -> Result<String, String> {
    Ok(db_path.0.to_string_lossy().to_string())
}

/// 刷新单个应用图标
#[tauri::command]
pub fn refresh_app_icon(
    db_path: State<'_, DbPath>,
    id: i64,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let conn = Connection::open(&db_path.0).map_err(|e| e.to_string())?;

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
