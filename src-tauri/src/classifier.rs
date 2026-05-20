/// 基于关键词的自动分类器
pub struct Classifier {
    rules: Vec<(Vec<&'static str>, &'static str)>,
}

impl Classifier {
    pub fn new() -> Self {
        let rules = vec![
            // 开发工具
            (vec!["code", "studio", "visual studio", "vscode", "intellij", "idea", "webstorm",
                  "pycharm", "goland", "clion", "rust", "cargo", "node", "npm", "git", "docker",
                  "terminal", "powershell", "cmd", "wsl", "putty", "ssh", "vim", "neovim",
                  "sublime", "atom", "notepad++", "eclipse", "android studio", "xcode",
                  "postman", "insomnia", "swagger", "jmeter", "gradle", "maven"], "开发"),

            // 办公软件
            (vec!["office", "word", "excel", "powerpoint", "outlook", "onenote", "wps",
                  "pdf", "adobe reader", "foxit", "notion", "evernote", "typora", "markdown",
                  "slack", "teams", "zoom", "meeting", "钉钉", "dingtalk", "飞书", "feishu",
                  "企业微信", "wecom", "石墨", "腾讯会议", "xmind", "mindmanager"], "办公"),

            // 浏览器
            (vec!["chrome", "google chrome", "edge", "firefox", "safari", "opera", "brave",
                  "chromium", "vivaldi", "tor", "iexplore", "internet explorer",
                  "360浏览器", "qq浏览器"], "浏览器"),

            // 娱乐媒体
            (vec!["spotify", "music", "网易云", "cloudmusic", "qq音乐", "foobar",
                  "vlc", "potplayer", "media player", "mpv", "播放器",
                  "bilibili", "哔哩哔哩", "youku", "爱奇艺", "tencent video",
                  "steam", "epic", "game", "游戏", "origin", "battle", "gog",
                  "discord", "twitch", "youtube"], "娱乐"),

            // 设计创意
            (vec!["photoshop", "ps", "illustrator", "ai", "figma", "sketch", "xd",
                  "premiere", "after effects", "ae", "da vinci", "resolver",
                  "blender", "maya", "3ds max", "cinema 4d", "c4d",
                  "lightroom", "capture one", "gimp", "inkscape", "krita",
                  "autocad", "solidworks", "sketchup", "fusion 360"], "设计"),

            // 通讯社交
            (vec!["wechat", "微信", "qq", "tim", "telegram", "whatsapp", "signal",
                  "discord", "slack", "line", "skype", "zoom"], "通讯"),

            // 系统工具
            (vec!["任务管理器", "task manager", "资源管理器", "explorer", "控制面板",
                  "control panel", "设置", "settings", "regedit", "msconfig",
                  "磁盘管理", "disk management", "clean", "管家", "360",
                  "驱动", "driver", "鲁大师", "cpu-z", "gpu-z", "hwinfo",
                  "ccleaner", "defraggler", "recuva", "everything",
                  "7-zip", "winrar", "bandizip", "压缩", "解压",
                  "snipaste", "截图", "screenshot", "sharex", "obs"], "系统工具"),
        ];

        Classifier { rules }
    }

    /// 根据应用名称和路径自动分类
    pub fn classify(&self, name: &str, path: &str) -> String {
        let lower_name = name.to_lowercase();
        let lower_path = path.to_lowercase();
        let combined = format!("{} {}", lower_name, lower_path);

        // 按顺序匹配关键词
        for (keywords, category) in &self.rules {
            for keyword in keywords {
                if combined.contains(keyword) {
                    return category.to_string();
                }
            }
        }

        "其他".to_string()
    }

    /// 批量分类未归类的应用
    pub fn classify_uncategorized(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<usize, rusqlite::Error> {
        let mut stmt = conn.prepare(
            "SELECT id, name, path FROM apps WHERE category = '未分类' OR category = ''",
        )?;
        let apps: Vec<(i64, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        if apps.is_empty() {
            return Ok(0);
        }

        let mut count = 0;
        for (id, name, path) in &apps {
            let category = self.classify(name, path);
            conn.execute(
                "UPDATE apps SET category = ?1 WHERE id = ?2",
                rusqlite::params![category, id],
            )?;
            count += 1;
        }

        Ok(count)
    }
}
