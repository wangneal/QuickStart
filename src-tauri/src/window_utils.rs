use tauri::Runtime;

/// 将窗口定位到屏幕左下角（任务栏上方），类似 Windows 开始菜单位置
/// 使用 Monitor::work_area() 获取排除任务栏后的有效区域，无需手动估算任务栏高度
pub fn position_window_bottom_left<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    // 获取窗口尺寸
    let window_size = match window.inner_size() {
        Ok(size) => size,
        Err(e) => {
            eprintln!("获取窗口尺寸失败: {e}");
            return;
        }
    };

    // 获取当前显示器信息
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        Ok(None) => {
            eprintln!("无法获取当前显示器信息");
            return;
        }
        Err(e) => {
            eprintln!("获取显示器信息失败: {e}");
            return;
        }
    };

    // work_area 已排除任务栏区域，直接使用即可
    let work_area = monitor.work_area();

    // 计算窗口左下角位置：
    // x = 工作区左边 + 小边距（8px，更美观）
    // y = 工作区底部 - 窗口高度 - 小边距（8px）
    let scale_factor = monitor.scale_factor();
    let margin = (8.0 * scale_factor) as i32;

    let x = work_area.position.x + margin;
    let y = work_area.position.y + work_area.size.height as i32 - window_size.height as i32 - margin;

    if let Err(e) = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y))) {
        eprintln!("设置窗口位置失败: {e}");
    }
}

/// 切换窗口显示/隐藏，显示时定位到左下角
pub fn toggle_window<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        // 先定位再显示，避免闪烁
        position_window_bottom_left(window);
        let _ = window.show();
        let _ = window.set_focus();
    }
}
