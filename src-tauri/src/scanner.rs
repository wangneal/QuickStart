use png::ColorType;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, SelectObject, BITMAP,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
};
use windows::Win32::UI::Controls::IImageList;
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

// SHIL_EXTRALARGE = 2 (48x48)
const SHIL_EXTRALARGE: i32 = 0x2;

use crate::pe_utils::{read_pe_subsystem, PeKind};

#[derive(Debug, Clone, Serialize)]
pub struct ScannedApp {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct ScanResult {
    pub apps: Vec<ScannedApp>,
    pub new_count: usize,
}

// ═══════════════════════════════════════════════════════════════
//  三层过滤：PE GUI 检查 → 系统工具白名单 → 名称黑名单
// ═══════════════════════════════════════════════════════════════

/// 系统工具白名单 — System32 下只有这些才保留
const SYSTEM_APP_WHITELIST: &[&str] = &[
    "calc.exe",
    "calculator.exe",   // 计算器
    "control.exe",      // 控制面板
    "mspaint.exe",      // 画图
    "notepad.exe",      // 记事本
    "snippingtool.exe", // 截图工具
    "scrnsave.scr",     // 屏幕保护程序
    "charmap.exe",      // 字符映射表
    "taskmgr.exe",      // 任务管理器
    "mstsc.exe",        // 远程桌面
    "explorer.exe",     // 资源管理器
    "wordpad.exe",      // 写字板
    "mmc.exe",          // 管理控制台（部分有用）
    "WindowsTerminal.exe",
    "wt.exe",       // Windows Terminal
    "ms-settings:", // UWP 设置协议
    // Win11 截图 & 画图 UWP
    "ScreenClippingHost.exe",
    "PaintApp.exe",
];

/// 名称黑名单 — 包含这些关键词的快捷方式直接排除
const NAME_BLACKLIST: &[&str] = &[
    // 卸载/安装
    "uninstall",
    "unins",
    "卸载",
    "setup",
    "安装",
    "installer",
    // 文档/帮助
    "readme",
    "help",
    "helper",
    "manual",
    "手册",
    "documentation",
    "docs",
    "changelog",
    "release notes",
    "更新日志",
    "版本说明",
    // 配置/工具
    "config",
    "configure",
    "配置",
    "settings",
    "选项",
    // 开发辅助
    "command prompt",
    "developer command",
    "developer powershell",
    "native tools command",
    "cross tools command",
    "命令提示符",
    // 系统管理（非日常使用）
    "diagnostic",
    "performance",
    "powershell",
    "regedit",
    "msconfig",
    "task manager",
    "resource monitor",
    "event viewer",
    "computer management",
    "disk management",
    "device manager",
    "services",
    "windows update",
    "windows security",
    "windows defender",
    "windows firewall",
    "任务管理器",
    "资源监视器",
    "事件查看器",
    "计算机管理",
    "磁盘管理",
    "设备管理器",
    "windows 更新",
    "windows 安全中心",
    "windows 防火墙",
    "运行",
    // Windows 系统/SDK 工具
    "windows",
    "microsoft",
    "application verifier",
    "debugging",
    "global flags",
    "gpuview",
    "log parser",
    "wfetch",
    "tinyget",
    "wcat",
    "iisstate",
    "iiscertdeploy",
    "selfssl",
    "permissions verifier",
    "metabase explorer",
    "security configuration",
    "debuggable package manager",
    // 后缀类
    "游戏中心",
];

/// 名称后缀黑名单 — 以这些后缀结尾的排除（如 "Steam Game Center"）
const NAME_SUFFIX_BLACKLIST: &[&str] = &[
    " game center",
    "游戏中心",
    " launcher",
    " desktop",
    " app",
    " client",
    " setup",
    " installer",
    " documentation",
    " 文档",
    " help",
    " 帮助",
    " readme",
    " samples",
    " 示例",
    " release notes",
    " revision history",
    " notes",
    " faq",
];

/// 判断一个扫描到的快捷方式是否是真正的应用程序
///
/// 三层过滤逻辑：
/// 1. PE 检查：解析 .lnk 目标 exe 的 PE header，只保留 GUI 应用
/// 2. 系统白名单：System32 下只有白名单中的应用才保留
/// 3. 名称黑名单：包含垃圾关键词的直接排除
fn is_real_app(name: &str, lnk_path: &str) -> bool {
    let n = name.to_lowercase();
    let lp = lnk_path.to_lowercase();

    // ── Layer 3: 名称黑名单（最快，先检查）──────────────────────
    for suffix in NAME_SUFFIX_BLACKLIST {
        if n.ends_with(suffix) {
            let base = n[..n.len().saturating_sub(suffix.len())].trim();
            if !base.is_empty() {
                return false;
            }
        }
    }
    for kw in NAME_BLACKLIST {
        if n.contains(kw) {
            return false;
        }
    }

    // ── Layer 1: PE Subsystem 检查 ──────────────────────────────
    // 解析 .lnk 指向的目标 exe，检查 PE header
    if let Some(target) = resolve_lnk_target(&lp) {
        let target_lower = target.to_lowercase();

        // Layer 2: 系统工具白名单 — System32 下的只保留白名单
        if target_lower.contains(r"c:\windows\system32")
            || target_lower.contains(r"c:\windows\syswow64")
        {
            let exe_name = Path::new(&target)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            return SYSTEM_APP_WHITELIST.iter().any(|w| exe_name == *w);
        }

        // 非 System32 的 exe：检查 PE subsystem
        let target_path = Path::new(&target);
        match read_pe_subsystem(target_path) {
            PeKind::GuiApp => return true,      // GUI 应用 → 保留
            PeKind::ConsoleApp => return false, // 控制台程序 → 排除
            PeKind::Native => return false,     // 驱动/系统组件 → 排除
            PeKind::Other(_) => return false,   // 其他子系统 → 排除
            PeKind::NotPe => {
                // 不是 PE 文件（可能是 .msc, URL, shell 命令等）
                // .msc 文件（MMC 管理单元）— 大部分不需要，但保留少数
                if target_lower.ends_with(".msc") {
                    return false;
                }
                // 非 exe 非 msc — 可能是协议链接等，排除
                return false;
            }
        }
    }

    // resolve_lnk 失败（损坏的快捷方式）→ 排除
    false
}

/// 解析 .lnk 快捷方式的目标路径（使用 lnk crate 避免 PowerShell 命令注入）
fn resolve_lnk_target(lnk_path: &str) -> Option<String> {
    use lnk::ShellLink;

    let path = Path::new(lnk_path);
    let shortcut = ShellLink::open(path).ok()?;

    // 尝试 relative_path -> working_dir + relative_path -> icon_location
    let target = shortcut
        .relative_path()
        .as_ref()
        .and_then(|p| if p.is_empty() { None } else { Some(p.clone()) })
        .or_else(|| {
            shortcut.working_dir().as_ref().and_then(|wd| {
                shortcut
                    .relative_path()
                    .as_ref()
                    .map(|rp| PathBuf::from(wd).join(rp).to_string_lossy().to_string())
            })
        })
        .or_else(|| {
            shortcut.icon_location().as_ref().and_then(|loc| {
                if loc.is_empty() {
                    None
                } else {
                    Some(loc.clone())
                }
            })
        })?;

    if target.is_empty() || !Path::new(&target).exists() {
        return None;
    }
    Some(target)
}

// ═══════════════════════════════════════════════════════════════
//  扫描入口
// ═══════════════════════════════════════════════════════════════

/// 扫描快捷方式并存入数据库
pub fn scan_and_save(
    conn: &Connection,
    _app_handle: &tauri::AppHandle,
) -> Result<ScanResult, String> {
    let mut all = Vec::new();

    // 开始菜单
    if let Ok(a) = scan_lnk(&[
        r"%ProgramData%\Microsoft\Windows\Start Menu\Programs",
        r"%APPDATA%\Microsoft\Windows\Start Menu\Programs",
    ]) {
        all.extend(a);
    }
    // 桌面（后加，同名覆盖开始菜单）
    if let Ok(a) = scan_lnk(&[r"%USERPROFILE%\Desktop", r"%PUBLIC%\Desktop"]) {
        all.extend(a);
    }

    // 按名称去重，桌面优先
    let mut seen: std::collections::HashMap<String, &ScannedApp> = std::collections::HashMap::new();
    for app in &all {
        seen.insert(app.name.to_lowercase(), app);
    }

    // ── 过滤 + 入库 ─────────────────────────────────────────────
    let mut new = 0;
    let mut filtered: Vec<ScannedApp> = Vec::new();
    // 确保'未分类'在 categories 表中（扫描新应用默认分类为'未分类'）
    conn.execute(
        "INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('未分类', (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
        [],
    ).ok(); // 忽略错误，categories 表可能不存在于首次启动前
    for app in seen.values() {
        if !is_real_app(&app.name, &app.path) {
            continue;
        }
        filtered.push((*app).clone());
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM apps WHERE path = ?1",
                [&app.path],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            conn.execute(
                "INSERT INTO apps (name,path,category) VALUES (?1,?2,'未分类')",
                rusqlite::params![app.name, app.path],
            )
            .map_err(|e| e.to_string())?;
            new += 1;
        }
    }

    // ── 回溯清理：删除数据库中已被新逻辑过滤掉的旧条目 ──────────
    cleanup_stale_entries(conn, &filtered);

    Ok(ScanResult {
        apps: filtered,
        new_count: new,
    })
}

/// 清理数据库中不再符合过滤条件的旧条目
fn cleanup_stale_entries(conn: &Connection, current_apps: &[ScannedApp]) {
    // 收集当前扫描通过的所有路径
    let valid_paths: std::collections::HashSet<String> =
        current_apps.iter().map(|a| a.path.to_lowercase()).collect();

    // 查询数据库中所有条目
    let mut stmt = match conn.prepare("SELECT id, name, path FROM apps") {
        Ok(s) => s,
        Err(_) => return,
    };
    let rows: Vec<(i64, String, String)> =
        match stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))) {
            Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
            Err(_) => return,
        };

    // 删除不再合法的条目
    for (id, name, path) in rows {
        let path_lower = path.to_lowercase();
        // 如果路径不在当前扫描结果中，且被新过滤逻辑排除，则删除
        if !valid_paths.contains(&path_lower) && !is_real_app(&name, &path) {
            let _ = conn.execute("DELETE FROM apps WHERE id = ?1", rusqlite::params![id]);
        }
    }
}

/// 扫 .lnk（第一层+子目录一层）
fn scan_lnk(dirs: &[&str]) -> Result<Vec<ScannedApp>, String> {
    let mut apps = Vec::new();
    for raw in dirs {
        let dir = PathBuf::from(expand(raw));
        if !dir.is_dir() {
            continue;
        }
        read_lnks(&dir, &mut apps);
        if let Ok(e) = std::fs::read_dir(&dir) {
            for en in e.flatten() {
                if en.path().is_dir() {
                    read_lnks(&en.path(), &mut apps);
                }
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
                let name = p
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                if !name.is_empty() {
                    apps.push(ScannedApp {
                        name,
                        path: p.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }
}

/// Extract icon using pure Win32 API (no PowerShell, no shell process spawning)
pub fn extract_and_cache_icon(app_path: &str, ah: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;

    let d = ah.path().app_data_dir().unwrap_or_default();
    let icon_dir = d.join("icons");
    std::fs::create_dir_all(&icon_dir).ok()?;

    let stem = Path::new(app_path).file_stem()?.to_string_lossy();
    let cache_path = icon_dir.join(format!("{}_256.png", stem));

    // Return cached icon if valid
    if cache_path.exists()
        && std::fs::metadata(&cache_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    {
        return Some(cache_path.to_string_lossy().to_string());
    }

    // Resolve .lnk target if needed (the caller passes .exe path, but we handle .lnk just in case)
    let src_path = if app_path.to_lowercase().ends_with(".lnk") {
        resolve_lnk_target(app_path).unwrap_or_else(|| app_path.to_string())
    } else {
        app_path.to_string()
    };

    if !Path::new(&src_path).exists() {
        return None;
    }

    // Extract icon using Win32 API
    match extract_icon_to_png(&src_path, &cache_path) {
        Ok(_) => {
            if cache_path.exists()
                && std::fs::metadata(&cache_path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            {
                Some(cache_path.to_string_lossy().to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

/// Extract icon from exe file using Win32 API and save as PNG
fn extract_icon_to_png(exe_path: &str, output_path: &Path) -> Result<(), String> {
    use std::fs::File;
    use std::io::BufWriter;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;

    // Convert exe_path to wide string
    let exe_path_wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    // Step 1: Get system icon index using SHGetFileInfoW with SHGFI_SYSICONINDEX
    let mut shfi = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR::from_raw(exe_path_wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        )
    };

    if result == 0 {
        return Err("SHGetFileInfoW failed".to_string());
    }

    let icon_index = shfi.iIcon;

    // Step 2: Get the SHIL_EXTRALARGE (48x48) image list via SHGetImageList
    let hicon = unsafe {
        let image_list_result: windows::core::Result<IImageList> = SHGetImageList(SHIL_EXTRALARGE);
        match image_list_result {
            Ok(il) => {
                // GetIcon from the image list at the given index
                match il.GetIcon(icon_index, 0x00000001 /* ILD_NORMAL */) {
                    Ok(icon) => icon,
                    Err(_) => HICON::default(),
                }
            }
            Err(_) => HICON::default(),
        }
    };

    // Fallback: if SHGetImageList failed, use classic SHGetFileInfoW with SHGFI_ICON
    let hicon = if hicon == HICON::default() {
        use windows::Win32::UI::Shell::{SHGFI_ICON, SHGFI_LARGEICON};
        let mut shfi2 = SHFILEINFOW::default();
        let flags2 = SHGFI_ICON | SHGFI_LARGEICON;
        let result2 = unsafe {
            SHGetFileInfoW(
                PCWSTR::from_raw(exe_path_wide.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut shfi2),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                flags2,
            )
        };
        if result2 == 0 {
            return Err("SHGetFileInfoW fallback failed".to_string());
        }
        shfi2.hIcon
    } else {
        hicon
    };

    if hicon == HICON::default() {
        return Err("No icon handle returned".to_string());
    }

    // Step 2: Get icon info and bitmap data
    let mut icon_info = ICONINFO::default();
    let result = unsafe { GetIconInfo(hicon, &mut icon_info) };
    if result.is_err() {
        let _ = unsafe { DestroyIcon(hicon) };
        return Err("GetIconInfo failed".to_string());
    }

    // Use the color bitmap (hbmColor), not the mask (hbmMask)
    let hbm = icon_info.hbmColor;
    if hbm.is_invalid() {
        // Cleanup and return error
        let _ =
            unsafe { DeleteObject(windows::Win32::Graphics::Gdi::HBITMAP(icon_info.hbmMask.0)) };
        if !icon_info.hbmColor.is_invalid() {
            let _ = unsafe { DeleteObject(icon_info.hbmColor) };
        }
        let _ = unsafe { DestroyIcon(hicon) };
        return Err("Invalid color bitmap handle".to_string());
    }

    // Get bitmap dimensions and pixel data
    let (width, height, pixel_data) = match get_bitmap_rgba(hbm) {
        Ok(data) => data,
        Err(e) => {
            let _ = unsafe {
                DeleteObject(windows::Win32::Graphics::Gdi::HBITMAP(icon_info.hbmMask.0))
            };
            let _ = unsafe { DeleteObject(icon_info.hbmColor) };
            let _ = unsafe { DestroyIcon(hicon) };
            return Err(e);
        }
    };

    // Cleanup GDI objects
    let _ = unsafe { DeleteObject(windows::Win32::Graphics::Gdi::HBITMAP(icon_info.hbmMask.0)) };
    let _ = unsafe { DeleteObject(icon_info.hbmColor) };
    let _ = unsafe { DestroyIcon(hicon) };

    // Step 3: Encode as PNG and save
    let file = File::create(output_path).map_err(|e| e.to_string())?;
    let writer = BufWriter::new(file);

    let mut encoder = png::Encoder::new(writer, width as u32, height as u32);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut png_writer = encoder.write_header().map_err(|e| e.to_string())?;
    png_writer
        .write_image_data(&pixel_data)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Extract RGBA pixel data from an HBITMAP
fn get_bitmap_rgba(hbm: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    unsafe {
        let hdc = CreateCompatibleDC(HDC::default());
        if hdc.is_invalid() {
            return Err("CreateCompatibleDC failed".to_string());
        }

        // Select the bitmap
        let old_bmp = SelectObject(hdc, hbm);

        // Get the bitmap dimensions
        let mut bm = BITMAP::default();
        let result = GetObjectW(
            hbm,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if result == 0 {
            let _ = DeleteDC(hdc);
            return Err("GetObjectW failed".to_string());
        }

        let width = bm.bmWidth;
        let height = bm.bmHeight.abs();

        // Allocate buffer for BGRA pixel data
        let mut pixels: Vec<u8> = vec![0; (width * height * 4) as usize];

        // Set up BITMAPINFO for GetDIBits (top-down, so negative height)
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;
        bmi.bmiHeader.biHeight = -height; // Top-down

        let result = GetDIBits(
            hdc,
            hbm,
            0,
            height as u32,
            Some(&mut pixels as *mut Vec<u8> as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup
        let _ = SelectObject(hdc, old_bmp);
        let _ = DeleteDC(hdc);

        if result == 0 {
            return Err("GetDIBits failed".to_string());
        }

        // Convert BGRA to RGBA
        for i in (0..pixels.len()).step_by(4) {
            pixels.swap(i, i + 2); // B <-> R
        }

        // Flip vertically (bitmap is bottom-up, PNG is top-down)
        let stride = width as usize * 4;
        let mut flipped: Vec<u8> = vec![0; pixels.len()];
        for y in 0..height as usize {
            let src_offset = y * stride;
            let dst_offset = (height as usize - 1 - y) * stride;
            flipped[dst_offset..dst_offset + stride]
                .copy_from_slice(&pixels[src_offset..src_offset + stride]);
        }

        Ok((width as u32, height as u32, flipped))
    }
}

fn expand(s: &str) -> String {
    let mut r = s.to_string();
    while let Some(i) = r.find('%') {
        if let Some(j) = r[i + 1..].find('%') {
            let k = &r[i + 1..i + 1 + j];
            if let Ok(v) = std::env::var(k) {
                r.replace_range(i..i + 2 + j, &v);
            } else {
                break;
            }
        } else {
            break;
        }
    }
    r
}
