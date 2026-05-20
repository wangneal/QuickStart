use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

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

/// 系统应用检查
fn is_system_app(name: &str, path: &str) -> bool {
    let n = name.to_lowercase();
    let p = path.to_lowercase();
    let kws = ["windows","microsoft","diagnostic","performance","powershell",
        "command prompt","regedit","msconfig","task manager","resource monitor",
        "event viewer","computer management","disk management","device manager",
        "services","windows update","windows security","windows defender",
        "windows firewall","控制面板","命令提示符","任务管理器","资源监视器",
        "事件查看器","计算机管理","磁盘管理","设备管理器","windows powershell",
        "windows 更新","windows 安全中心","windows 防火墙","运行",
        "uninstall","unins","卸载","setup","setup.exe","安装",
        "config","configure","配置","readme","help","manual","手册",
        "readme.txt","readme.md"];
    for kw in kws { if n.contains(kw) { return true; } }
    let sys = [r"c:\windows\", r"\windows powershell\", r"\administrative tools\"];
    for d in sys { if p.contains(d) { return true; } }
    false
}

/// 扫描快捷方式并存入数据库
pub fn scan_and_save(conn: &Connection, _app_handle: &tauri::AppHandle) -> Result<ScanResult, String> {
    let mut all = Vec::new();

    // 开始菜单
    if let Ok(a) = scan_lnk(&[r"%ProgramData%\Microsoft\Windows\Start Menu\Programs",
                               r"%APPDATA%\Microsoft\Windows\Start Menu\Programs"]) {
        all.extend(a);
    }
    // 桌面（后加，同名覆盖开始菜单）
    if let Ok(a) = scan_lnk(&[r"%USERPROFILE%\Desktop", r"%PUBLIC%\Desktop"]) {
        all.extend(a);
    }

    // 按名称去重，桌面优先
    let mut seen: std::collections::HashMap<String, &ScannedApp> = std::collections::HashMap::new();
    for app in &all { seen.insert(app.name.to_lowercase(), app); }

    let mut new = 0;
    for app in seen.values() {
        if is_system_app(&app.name, &app.path) { continue; }
        let exists: bool = conn
            .query_row("SELECT 1 FROM apps WHERE path = ?1", [&app.path], |_| Ok(()))
            .is_ok();
        if !exists {
            conn.execute("INSERT INTO apps (name,path,category) VALUES (?1,?2,'未分类')",
                rusqlite::params![app.name, app.path]).map_err(|e| e.to_string())?;
            new += 1;
        }
    }

    let v: Vec<ScannedApp> = seen.values().map(|a| (*a).clone()).collect();
    Ok(ScanResult { apps: v, new_count: new })
}

/// 扫 .lnk（第一层+子目录一层）
fn scan_lnk(dirs: &[&str]) -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    for raw in dirs {
        let dir = PathBuf::from(expand(raw));
        if !dir.is_dir() { continue; }
        read_lnks(&dir, &mut apps);
        if let Ok(e) = std::fs::read_dir(&dir) {
            for en in e.flatten() {
                if en.path().is_dir() { read_lnks(&en.path(), &mut apps); }
            }
        }
    }
    Ok(apps)
}

fn read_lnks(dir: &Path, apps: &mut Vec<ScannedApp>) {
    if let Ok(e) = std::fs::read_dir(dir) {
        for en in e.flatten() {
            let p = en.path();
            if p.extension().map(|x| x.to_string_lossy().to_lowercase()) == Some("lnk".into()) {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
                if !name.is_empty() { apps.push(ScannedApp { name, path: p.to_string_lossy().to_string() }); }
            }
        }
    }
}

/// 提取图标（单个，首次提取调 PowerShell，后续直接读缓存）
pub fn extract_and_cache_icon(app_path: &str, ah: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    use std::path::Path;
    let d = ah.path().app_data_dir().unwrap_or_default();
    let c = d.join("icons"); std::fs::create_dir_all(&c).ok()?;
    let stem = Path::new(app_path).file_stem()?.to_string_lossy();
    let cp = c.join(format!("{}.png", stem));
    if cp.exists() { return Some(cp.to_string_lossy().to_string()); }

    let src = if app_path.to_lowercase().ends_with(".lnk") {
        resolve_lnk(app_path).unwrap_or_else(|| app_path.to_string())
    } else { app_path.to_string() };

    let ps = format!(
        "Add-Type -AssemblyName System.Drawing; \
         $icon=[System.Drawing.Icon]::ExtractAssociatedIcon('{}'); \
         if($icon-ne$null){{$b=$icon.ToBitmap();$b.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png);$b.Dispose();$icon.Dispose()}}",
        src.replace('\'',"''"), cp.to_string_lossy().replace('\'',"''")
    );
    std::process::Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",&ps])
        .output().ok().and_then(|o| if o.status.success() { Some(cp.to_string_lossy().to_string()) } else { None })
}

fn resolve_lnk(p: &str) -> Option<String> {
    let ps = format!("$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut('{}');Write-Output $sc.TargetPath", p.replace('\'',"''"));
    let o = std::process::Command::new("powershell").args(["-NoProfile","-NonInteractive","-Command",&ps]).output().ok()?;
    if o.status.success() { let t = String::from_utf8_lossy(&o.stdout).trim().to_string(); if !t.is_empty() && Path::new(&t).exists() { return Some(t); } }
    None
}

fn expand(s: &str) -> String {
    let mut r = s.to_string();
    while let Some(i) = r.find('%') { if let Some(j) = r[i+1..].find('%') { let k = &r[i+1..i+1+j]; if let Ok(v) = std::env::var(k) { r.replace_range(i..i+2+j, &v); } else { break; } } else { break; } }
    r
}
