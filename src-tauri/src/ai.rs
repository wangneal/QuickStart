use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

/// SSE 事件类型
enum SseEvent {
    Data(String),
    Done,
}

/// 解析 SSE 行，返回事件或 None（忽略非数据行）
fn parse_sse_line(line: &str) -> Option<SseEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if line.starts_with(':') {
        return None; // 忽略注释行
    }
    if line == "data: [DONE]" {
        return Some(SseEvent::Done);
    }
    if let Some(data) = line.strip_prefix("data: ") {
        return Some(SseEvent::Data(data.to_string()));
    }
    None // 忽略 event:, id:, retry: 等行
}

/// AI 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 验证路径是否在允许的基础目录内，防止路径遍历攻击
fn validate_path_within_base(path: &Path, base: &Path) -> Result<(), String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("无效路径: {}", e))?;
    let canonical_base = base
        .canonicalize()
        .map_err(|e| format!("无效基础路径: {}", e))?;
    if !canonical_path.starts_with(&canonical_base) {
        return Err("目标路径超出允许范围".into());
    }
    Ok(())
}

/// 文件夹条目
#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 发送聊天并流式接收回复
#[tauri::command]
pub async fn ai_chat_stream(
    app_handle: AppHandle,
    messages: Vec<ChatMessage>,
    provider: String,
    model: String,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let event_id = "ai:token";

    match provider.as_str() {
        "openai" | "custom" => {
            let url = if provider == "custom" {
                format!("{}/chat/completions", base_url.trim_end_matches('/'))
            } else {
                "https://api.openai.com/v1/chat/completions".to_string()
            };

            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
                "max_tokens": 4096,
            });

            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求失败: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("API request failed: {} - {}", status, body).into());
            }

            let mut stream = resp.bytes_stream();
            use futures_util::StreamExt;
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("流读取失败: {}", e))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].to_string();
                    buffer = buffer[line_end + 1..].to_string();

                    match parse_sse_line(&line) {
                        Some(SseEvent::Done) => break,
                        Some(SseEvent::Data(data)) => {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                                if let Some(content) = parsed["choices"][0]["delta"]["content"]
                                    .as_str()
                                    .map(|s| s.to_string())
                                {
                                    let _ = app_handle.emit(event_id, content);
                                }
                            }
                        }
                        None => {}
                    }
                }
            }
        }
        "claude" => {
            // Claude Messages API
            let url = "https://api.anthropic.com/v1/messages";

            // 转换消息格式
            let claude_messages: Vec<serde_json::Value> = messages
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "role": m.role,
                        "content": m.content
                    })
                })
                .collect();

            let body = serde_json::json!({
                "model": model,
                "messages": claude_messages,
                "max_tokens": 4096,
                "stream": true,
            });

            let resp = client
                .post(url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Claude 请求失败: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("API request failed: {} - {}", status, body).into());
            }

            let mut stream = resp.bytes_stream();
            use futures_util::StreamExt;
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("流读取失败: {}", e))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].to_string();
                    buffer = buffer[line_end + 1..].to_string();

                    if let Some(SseEvent::Data(data)) = parse_sse_line(&line) {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
                            if parsed["type"] == "content_block_delta" {
                                if let Some(text) = parsed["delta"]["text"].as_str() {
                                    let _ = app_handle.emit(event_id, text.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        "ollama" => {
            let url = format!(
                "{}/api/chat",
                if base_url.is_empty() {
                    "http://localhost:11434".to_string()
                } else {
                    base_url.trim_end_matches('/').to_string()
                }
            );

            let body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": true,
            });

            let resp = client
                .post(&url)
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Ollama 请求失败: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("API request failed: {} - {}", status, body).into());
            }

            let mut stream = resp.bytes_stream();
            use futures_util::StreamExt;
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("流读取失败: {}", e))?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].trim().to_string();
                    buffer = buffer[line_end + 1..].to_string();

                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(content) = parsed["message"]["content"].as_str() {
                            let _ = app_handle.emit(event_id, content.to_string());
                        }
                        if parsed.get("done").and_then(|d| d.as_bool()) == Some(true) {
                            break;
                        }
                    }
                }
            }
        }
        _ => return Err(format!("不支持的 AI 提供商: {}", provider)),
    }

    let _ = app_handle.emit("ai:done", "");
    Ok(())
}

/// 列出指定目录的内容（用于 AI 工具调用）
#[tauri::command]
pub fn list_directory(app_handle: AppHandle, path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);

    // 获取允许的基础路径
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // 构建允许目录列表：app data + 用户常见目录
    let allowed_dirs = {
        let mut dirs = vec![app_data_dir.clone()];

        // 添加用户目录（从 USERPROFILE 环境变量）
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_path = Path::new(&user_profile);
            for name in &[
                "Desktop",
                "Documents",
                "Downloads",
                "Pictures",
                "Videos",
                "Music",
            ] {
                let sub_dir = user_path.join(name);
                if sub_dir.is_dir() {
                    dirs.push(sub_dir);
                }
            }
        }

        dirs
    };

    // 验证路径在允许范围内
    let mut path_valid = false;
    for base_dir in &allowed_dirs {
        if validate_path_within_base(dir, base_dir).is_ok() {
            path_valid = true;
            break;
        }
    }
    if !path_valid {
        return Err("路径超出允许范围".to_string());
    }

    if !dir.is_dir() {
        return Err("路径不是有效的目录".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir: path.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// 获取应用列表（供 AI 工具调用）
#[tauri::command]
pub fn ai_get_apps(app_handle: AppHandle) -> Result<Vec<crate::commands::AppData>, String> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let db_path = app_dir.join("quickstart.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, icon_path, category, use_count, is_pinned, COALESCE(sort_order, 0) FROM apps ORDER BY category, name")
        .map_err(|e| e.to_string())?;

    let apps = stmt
        .query_map([], |row| {
            Ok(crate::commands::AppData {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                icon_path: row.get(3)?,
                category: row.get(4)?,
                use_count: row.get(5)?,
                is_pinned: row.get::<_, i64>(6)? != 0,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(apps)
}

/// LLM 自动分类未归类应用

/// 从 AI 响应中提取 JSON，支持 markdown 代码块包裹
fn extract_json_from_response(text: &str) -> Option<&str> {
    let text = text.trim();
    let text = text.strip_prefix("```json").unwrap_or(text);
    let text = text.strip_prefix("```").unwrap_or(text);
    let text = text.strip_suffix("```").unwrap_or(text);
    let text = text.trim();

    let start = text.find('{')?;
    let end = text.rfind('}')? + 1;
    Some(&text[start..end])
}

#[tauri::command]
pub async fn ai_classify_apps(
    _app_handle: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<usize, String> {
    // 先读 DB，收集数据后关闭连接（避免 Send 问题）
    let (names, provider, api_key, model, base_url) = {
        let conn = state.db_conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare("SELECT name FROM apps WHERE category = '未分类' OR category = '' LIMIT 50")
            .map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let provider: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_provider'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        let api_key: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_api_key'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();
        let model: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_model'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "gpt-4o-mini".into());
        let base_url: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_base_url'",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();

        (names, provider, api_key, model, base_url)
    }; // conn 在这里 drop

    if names.is_empty() {
        return Ok(0);
    }
    if provider.is_empty() || api_key.is_empty() {
        return Err("请在设置中配置 AI 提供商和 API Key".into());
    }

    let names_list = names.join("\n");
    let system_prompt = "你是一个 Windows 应用分类专家。根据应用名归类，只返回 JSON 数组 [{\"name\":\"应用名\",\"category\":\"类别\"}]，不要其他文字。\n类别说明：\n- 开发: IDE(VSCode/IntelliJ/PyCharm), 编辑器(Vim/Sublime), 终端(CMD/PowerShell), Git, Docker, Node, 数据库, Postman\n- 办公: Office/Word/Excel/PPT/WPS, PDF, Notion, 会议(Zoom/腾讯会议), 思维导图, 笔记\n- 浏览器: Chrome, Edge, Firefox, Brave, Opera, 360浏览器\n- 娱乐: Steam/游戏, 音乐(网易云/Spotify), 视频(爱奇艺/哔哩哔哩), 直播\n- 设计: PS, Figma, Blender, AutoCAD, 3ds Max, 剪辑(Premiere/剪映)\n- 通讯: 微信, QQ, 钉钉, 飞书, Telegram, Discord, Slack, Zoom\n- 系统工具: 压缩(7z/WinRAR), 截图, 清理, 驱动, 磁盘工具, Everything\n- 教育: 词典, 翻译, 编程学习, 数学\n- 其他: 不好分类的放这里\n注意：遇到不熟悉的应用名，根据名称关键词和常识推断类别，不要留空或跳过";
    let user_prompt = format!("分类以下 Windows 应用：\n{}", names_list);

    let messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt}),
        serde_json::json!({"role": "user", "content": user_prompt}),
    ];

    let url = match provider.as_str() {
        "openai" => "https://api.openai.com/v1/chat/completions".to_string(),
        "custom" => format!("{}/chat/completions", base_url.trim_end_matches('/')),
        _ => return Err(format!("不支持的提供商: {}", provider)),
    };

    let body = serde_json::json!({
        "model": model, "messages": messages, "temperature": 0.1, "max_tokens": 2000
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("API 请求失败: {}", e))?;

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;
    let content = result["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("AI 返回为空")?;

    let json_str = extract_json_from_response(content)
        .ok_or_else(|| format!("无法从 AI 响应中提取 JSON。原始响应: {}", content))?;
    let items: Vec<serde_json::Value> = serde_json::from_str(json_str)
        .map_err(|e| format!("解析分类结果失败: {}. 原始响应: {}", e, content))?;

    // 用共享连接写结果（避免绕过 Mutex 开新连接）
    let conn = state.db_conn.lock().map_err(|e| e.to_string())?;
    let mut count = 0;
    // 收集 AI 分类产生的新分类名，用于同步到 categories 表
    let mut new_categories: Vec<String> = Vec::new();
    for item in &items {
        if let (Some(name), Some(cat)) = (item["name"].as_str(), item["category"].as_str()) {
            if conn.execute(
                "UPDATE apps SET category = ?1 WHERE LOWER(name) = LOWER(?2) AND (category = '未分类' OR category = '')",
                rusqlite::params![cat, name],
            ).map_err(|e| e.to_string())? > 0 {
                count += 1;
            }
            new_categories.push(cat.to_string());
        }
    }
    // 同步新分类到 categories 表（避免分类重复）
    for cat in &new_categories {
        conn.execute(
            "INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories))",
            rusqlite::params![cat],
        ).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// 安全整理文件夹：只移动文件到目标目录，不删除不重命名
#[tauri::command]
pub fn organize_folder(
    app_handle: AppHandle,
    source: String,
    target_dir: String,
) -> Result<String, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let src = Path::new(&source);
    let dst_dir = Path::new(&target_dir);

    // 验证源路径在允许范围内
    validate_path_within_base(src, &base_dir)?;
    // 验证目标路径在允许范围内
    validate_path_within_base(dst_dir, &base_dir)?;

    if !src.exists() {
        return Err("源文件不存在".into());
    }
    if !dst_dir.is_dir() {
        return Err("目标目录不存在".into());
    }

    let file_name = src.file_name().ok_or("无效文件名")?;
    let dest = dst_dir.join(file_name);

    // 如果目标已存在，加数字后缀
    let final_dest = if dest.exists() {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let ext = src
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut i = 1;
        loop {
            let candidate = dst_dir.join(format!("{}_{}{}", stem, i, ext));
            if !candidate.exists() {
                break candidate;
            }
            i += 1;
        }
    } else {
        dest
    };

    std::fs::rename(&source, &final_dest).map_err(|e| format!("移动失败: {}", e))?;
    Ok(format!("已移动到: {}", final_dest.display()))
}
