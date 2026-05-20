use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct ScannedApp {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub apps: Vec<ScannedApp>,
    pub new_count: usize,
}

/// 扫描快捷方式并存入数据库（不提取图标，不解析 lnk 目标）
pub fn scan_and_save(conn: &Connection, _app_handle: &tauri::AppHandle) -> Result<ScanResult, String> {
    let mut all_apps = Vec::new();

    // 开始菜单
    if let Ok(apps) = scan_lnk_dirs(&[
        r"%ProgramData%\Microsoft\Windows\Start Menu\Programs",
        r"%APPDATA%\Microsoft\Windows\Start Menu\Programs",
    ]) {
        all_apps.extend(apps);
    }

    // 桌面
    if let Ok(apps) = scan_lnk_dirs(&[
        r"%PUBLIC%\Desktop",
        r"%USERPROFILE%\Desktop",
    ]) {
        all_apps.extend(apps);
    }

    // 去重入库（路径去重）
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut new_count = 0;

    for app in &all_apps {
        let key = app.path.to_lowercase();
        if seen.contains(&key) { continue; }
        seen.insert(key);

        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM apps WHERE path = ?1",
                [&app.path],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            conn.execute(
                "INSERT INTO apps (name, path, category) VALUES (?1, ?2, '未分类')",
                rusqlite::params![app.name, app.path],
            )
            .map_err(|e| e.to_string())?;
            new_count += 1;
        }
    }

    Ok(ScanResult { apps: all_apps, new_count })
}

/// 扫描多个目录下的 .lnk 文件（仅第一层，不递归）
fn scan_lnk_dirs(raw_dirs: &[&str]) -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();

    for raw in raw_dirs {
        let expanded = expand_env(raw);
        let dir = PathBuf::from(&expanded);
        if !dir.is_dir() { continue; }

        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e.to_string_lossy().to_lowercase()) == Some("lnk".into()) {
                    let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    if !name.is_empty() {
                        apps.push(ScannedApp { name, path: path.to_string_lossy().to_string() });
                    }
                }
            }
        }

        // 也扫一层子目录（如 Start Menu\Programs\ 下有子文件夹）
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let sub = entry.path();
                if sub.is_dir() {
                    if let Ok(subs) = std::fs::read_dir(&sub) {
                        for s in subs.flatten() {
                            let p = s.path();
                            if p.extension().map(|e| e.to_string_lossy().to_lowercase()) == Some("lnk".into()) {
                                let name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                                if !name.is_empty() {
                                    apps.push(ScannedApp { name, path: p.to_string_lossy().to_string() });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(apps)
}

/// 提取并缓存应用图标（按需调用，不在扫描时执行）
pub fn extract_and_cache_icon(app_path: &str, app_handle: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    use std::path::Path;
    let app_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cache_dir = app_dir.join("icons");
    std::fs::create_dir_all(&cache_dir).ok()?;
    let path = Path::new(app_path);
    let stem = path.file_stem()?.to_string_lossy();
    let cache_path = cache_dir.join(format!("{}.png", stem));
    if cache_path.exists() { return Some(cache_path.to_string_lossy().to_string()); }

    let ps_script = format!(
        "Add-Type -AssemblyName System.Drawing; \
         $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
         if ($icon -ne $null) {{ $bmp = $icon.ToBitmap(); $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $icon.Dispose() }}",
        app_path.replace('\'', "''"),
        cache_path.to_string_lossy().replace('\'', "''")
    );

    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output().ok()
        .and_then(|o| if o.status.success() { Some(cache_path.to_string_lossy().to_string()) } else { None })
}

/// 展开环境变量（极简实现，只处理 %XXX% 格式）
fn expand_env(s: &str) -> String {
    let mut result = s.to_string();
    while let Some(start) = result.find('%') {
        if let Some(end) = result[start + 1..].find('%') {
            let key = &result[start + 1..start + 1 + end];
            if let Ok(val) = std::env::var(key) {
                result.replace_range(start..start + 2 + end, &val);
            } else {
                break;
            }
        } else {
            break;
        }
    }
    result
}
