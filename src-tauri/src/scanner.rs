use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 扫描到的应用信息
#[derive(Debug, Clone, Serialize)]
pub struct ScannedApp {
    pub name: String,
    pub path: String,
    pub icon_path: Option<String>,
}

/// 应用扫描结果
#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub apps: Vec<ScannedApp>,
    pub new_count: usize,
}

/// 扫描所有可发现的应用并存入数据库
pub fn scan_and_save(conn: &Connection, app_handle: &tauri::AppHandle) -> Result<ScanResult, String> {
    let mut all_apps = Vec::new();
    let mut new_count = 0;

    // 扫描开始菜单
    if let Ok(apps) = scan_start_menu() {
        all_apps.extend(apps);
    }

    // 扫描桌面
    if let Ok(apps) = scan_desktop() {
        all_apps.extend(apps);
    }

    // 扫描注册表 App Paths
    if let Ok(apps) = scan_registry_app_paths() {
        all_apps.extend(apps);
    }

    // 扫描 UWP 应用
    if let Ok(apps) = scan_uwp_apps() {
        all_apps.extend(apps);
    }

    // 去重并存入数据库
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    for app in &all_apps {
        let normalized = app.path.to_lowercase().replace('/', "\\");
        if seen_paths.contains(&normalized) {
            continue;
        }
        seen_paths.insert(normalized);

        // 检查是否已存在
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM apps WHERE LOWER(path) = ?1",
                [&app.path.to_lowercase()],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            // 提取并缓存图标
            let icon_path = extract_and_cache_icon(&app.path, app_handle);

            conn.execute(
                "INSERT INTO apps (name, path, icon_path, category) VALUES (?1, ?2, ?3, '未分类')",
                rusqlite::params![app.name, app.path, icon_path],
            )
            .map_err(|e| e.to_string())?;

            new_count += 1;
        }
    }

    Ok(ScanResult {
        apps: all_apps.clone(),
        new_count,
    })
}

/// 扫描开始菜单中的快捷方式
fn scan_start_menu() -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    let start_menu_dirs = vec![
        PathBuf::from(
            std::env::var("ProgramData")
                .unwrap_or_else(|_| r"C:\ProgramData".to_string()),
        )
        .join(r"Microsoft\Windows\Start Menu\Programs"),
        PathBuf::from(
            std::env::var("APPDATA")
                .unwrap_or_else(|_| r"C:\Users\Default\AppData\Roaming".to_string()),
        )
        .join(r"Microsoft\Windows\Start Menu\Programs"),
    ];

    for dir in start_menu_dirs {
        if !dir.exists() {
            continue;
        }
        if let Ok(entries) = walk_directory(&dir) {
            apps.extend(entries);
        }
    }

    Ok(apps)
}

/// 扫描桌面快捷方式
fn scan_desktop() -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    let desktop_dirs = vec![
        PathBuf::from(
            std::env::var("PUBLIC")
                .unwrap_or_else(|_| r"C:\Users\Public".to_string()),
        )
        .join("Desktop"),
        PathBuf::from(
            std::env::var("USERPROFILE")
                .unwrap_or_else(|_| r"C:\Users\Default".to_string()),
        )
        .join("Desktop"),
    ];

    for dir in desktop_dirs {
        if !dir.exists() {
            continue;
        }
        if let Ok(entries) = walk_directory(&dir) {
            apps.extend(entries);
        }
    }

    Ok(apps)
}

/// 扫描注册表中的应用程序路径
fn scan_registry_app_paths() -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    let key_paths = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ];

    for key_path in &key_paths {
        if let Ok(entries) = scan_registry_key(key_path) {
            apps.extend(entries);
        }
    }

    Ok(apps)
}

/// 扫描注册表键
fn scan_registry_key(key_path: &str) -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    let hklm = r"HKLM\";
    let full_path = format!("{}{}", hklm, key_path);

    // 使用 reg query 命令查询注册表
    let output = std::process::Command::new("reg")
        .arg("query")
        .arg(&full_path)
        .output()
        .map_err(|e| format!("reg query failed: {}", e))?;

    if !output.status.success() {
        return Ok(apps); // 键不存在，静默忽略
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(full_path.as_str()) || line.starts_with("HK") {
            continue;
        }
        // 提取路径
        if let Some(path) = extract_exe_path_from_reg_line(line) {
            let name = Path::new(&path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if !name.is_empty() {
                apps.push(ScannedApp {
                    name,
                    path,
                    icon_path: None,
                });
            }
        }
    }

    Ok(apps)
}

/// 从注册表查询结果行中提取 exe 路径
fn extract_exe_path_from_reg_line(line: &str) -> Option<String> {
    // 格式类似于: "    (默认)    REG_SZ    C:\Path\to\app.exe"
    let parts: Vec<&str> = line.split("REG_SZ").collect();
    if parts.len() < 2 {
        return None;
    }
    let path = parts[1].trim().trim_matches('"').to_string();
    if path.ends_with(".exe") && Path::new(&path).exists() {
        Some(path)
    } else {
        None
    }
}

/// 扫描 UWP 应用 (通过 PowerShell)
fn scan_uwp_apps() -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();

    // 使用 PowerShell 获取 UWP 应用
    let ps_script = r#"
        Get-StartApps | Where-Object { $_.AppId -notlike '*Microsoft.Windows.*' -and $_.AppId -notlike '*WindowsStore*' } | ForEach-Object {
            [PSCustomObject]@{
                Name = $_.Name
                AppId = $_.AppId
            }
        } | ConvertTo-Json
    "#;

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            ps_script,
        ])
        .output()
        .map_err(|e| format!("PowerShell query failed: {}", e))?;

    if !output.status.success() {
        return Ok(apps); // 静默忽略
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() || stdout.trim() == "null" {
        return Ok(apps);
    }

    // 解析 JSON 输出
    if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
        for item in items {
            let name = item["Name"].as_str().unwrap_or("").to_string();
            let app_id = item["AppId"].as_str().unwrap_or("").to_string();
            if !name.is_empty() && !app_id.is_empty() {
                // UWP 应用通过 shell:AppsFolder 协议启动
                apps.push(ScannedApp {
                    name,
                    path: format!("shell:AppsFolder\\{}", app_id),
                    icon_path: None,
                });
            }
        }
    }

    Ok(apps)
}

/// 递归遍历目录查找快捷方式和 exe
fn walk_directory(dir: &Path) -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    let max_depth = 3;

    if !dir.is_dir() {
        return Ok(apps);
    }

    walk_dir_recursive(dir, dir, 0, max_depth, &mut apps)
        .map_err(|e| format!("遍历目录失败: {}", e))?;

    Ok(apps)
}

fn walk_dir_recursive(
    base_dir: &Path,
    current_dir: &Path,
    depth: i32,
    max_depth: i32,
    apps: &mut Vec<ScannedApp>,
) -> Result<(), std::io::Error> {
    if depth > max_depth {
        return Ok(());
    }

    for entry in std::fs::read_dir(current_dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy().to_string();

        // 跳过隐藏文件和目录
        if file_name.starts_with('.') || file_name == "desktop.ini" {
            continue;
        }

        if path.is_dir() {
            // 跳过特殊系统目录
            let name_lower = file_name.to_lowercase();
            if name_lower == "uninstall" || name_lower == "resources" {
                continue;
            }
            walk_dir_recursive(base_dir, &path, depth + 1, max_depth, apps)?;
        } else if path.is_file() {
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();

            if ext == "lnk" || ext == "exe" {
                // 对于快捷方式，解析目标路径
                let target_path = if ext == "lnk" {
                    resolve_lnk_target(&path).unwrap_or(path.to_string_lossy().to_string())
                } else {
                    path.to_string_lossy().to_string()
                };

                // 提取名称
                let name = if ext == "lnk" {
                    file_name.trim_end_matches(".lnk").to_string()
                } else {
                    file_name.trim_end_matches(".exe").to_string()
                };

                if !name.is_empty() {
                    apps.push(ScannedApp {
                        name,
                        path: target_path,
                        icon_path: None,
                    });
                }
            }
        }
    }

    Ok(())
}

/// 解析 .lnk 快捷方式的目标路径
/// 简单的实现：读取快捷方式的 link info
fn resolve_lnk_target(lnk_path: &Path) -> Option<String> {
    // 使用 PowerShell 解析快捷方式
    let ps_script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $sc = $ws.CreateShortcut('{}'); \
         Write-Output $sc.TargetPath",
        lnk_path.to_string_lossy().replace('\'', "''")
    );

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .ok()?;

    if output.status.success() {
        let target = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();
        if !target.is_empty() && Path::new(&target).exists() {
            return Some(target);
        }
    }

    None
}

/// 提取并缓存应用图标
pub fn extract_and_cache_icon(app_path: &str, app_handle: &tauri::AppHandle) -> Option<String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let cache_dir = app_dir.join("icons");
    std::fs::create_dir_all(&cache_dir).ok()?;

    // 从路径中提取文件名作为缓存 key
    let path = Path::new(app_path);
    let stem = path.file_stem()?.to_string_lossy();
    let cache_path = cache_dir.join(format!("{}.png", stem));

    // 如果已缓存，直接返回
    if cache_path.exists() {
        return Some(cache_path.to_string_lossy().to_string());
    }

    // 使用 Win32 API 提取图标并保存为 PNG
    extract_icon_via_powershell(app_path, &cache_path)
        .then(|| cache_path.to_string_lossy().to_string())
}

/// 通过 PowerShell 提取 exe 图标
fn extract_icon_via_powershell(exe_path: &str, output_png: &Path) -> bool {
    let ps_script = format!(
        r#"
        Add-Type -AssemblyName System.Drawing
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon('{}')
        if ($icon -ne $null) {{
            $bmp = $icon.ToBitmap()
            $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            $icon.Dispose()
        }}
        "#,
        exe_path.replace('\'', "''"),
        output_png.to_string_lossy().replace('\'', "''")
    );

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &ps_script,
        ])
        .output()
        .ok();

    match output {
        Some(o) => o.status.success(),
        None => false,
    }
}
