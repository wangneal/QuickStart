use rusqlite::{Connection, Result};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

/// 获取数据库文件路径
pub fn get_db_path(app_handle: &AppHandle) -> PathBuf {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&app_dir).ok();
    app_dir.join("quickstart.db")
}

/// 初始化数据库表
pub fn init_database(db_path: &Path) -> Result<()> {
    let conn = Connection::open(db_path)?;

    // 应用表
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS apps (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL,
            icon_path   TEXT,
            category    TEXT DEFAULT '未分类',
            use_count   INTEGER DEFAULT 0,
            is_pinned   INTEGER DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS categories (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            sort_order  INTEGER DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS folders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL,
            sort_order  INTEGER DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            model       TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT OR IGNORE INTO categories (name, sort_order)
        SELECT DISTINCT TRIM(category),
               (SELECT COALESCE(MAX(sort_order), 0) FROM categories) + ROW_NUMBER() OVER ()
        FROM apps
        WHERE TRIM(COALESCE(category, '')) <> ''
          AND TRIM(category) <> '全部';

        -- 插入默认设置
        INSERT OR IGNORE INTO settings (key, value) VALUES
            ('hotkey', 'Alt+Space'),
            ('auto_start', 'true'),
            ('theme', 'system'),
            ('auto_classify', 'true'),
            ('ai_provider', ''),
            ('ai_api_key', ''),
            ('ai_base_url', ''),
            ('ai_model', '');
        ",
    )?;

    Ok(())
}

/// 获取设置值
#[allow(dead_code)]
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

/// 设置值
#[allow(dead_code)]
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        [key, value],
    )?;
    Ok(())
}
