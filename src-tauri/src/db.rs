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

    // 迁移：为已有 folders 表添加 category 列（SQLite 不支持 IF NOT EXISTS ALTER）
    {
        let has_category: bool = conn
            .prepare("PRAGMA table_info(folders)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .any(|col| col == "category");
        if !has_category {
            conn.execute_batch(
                "ALTER TABLE folders ADD COLUMN category TEXT DEFAULT '未分类';
                 CREATE TABLE IF NOT EXISTS folder_categories (
                     id          INTEGER PRIMARY KEY AUTOINCREMENT,
                     name        TEXT NOT NULL UNIQUE,
                     sort_order  INTEGER DEFAULT 0,
                     created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
                 );"
            )?;
        }
    }

    // 搜索历史表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL,
            searched_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_search_history_query ON search_history(query);
        CREATE INDEX IF NOT EXISTS idx_search_history_at ON search_history(searched_at);"
    )?;

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
            category    TEXT DEFAULT '未分类',
            sort_order  INTEGER DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS folder_categories (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
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

        -- 迁移：为已有 folders 表添加 category 列（SQLite ALTER TABLE 只能 ADD COLUMN）
        -- PRAGMA table_info 检查列是否存在，不存在则添加
        INSERT OR IGNORE INTO folder_categories (name, sort_order)
        SELECT DISTINCT TRIM(category),
               (SELECT COALESCE(MAX(sort_order), 0) FROM folder_categories) + ROW_NUMBER() OVER ()
        FROM folders
        WHERE TRIM(COALESCE(category, '')) <> ''
          AND TRIM(category) <> '全部'
          AND TRIM(category) <> '未分类';

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
