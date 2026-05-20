# QuickStart

轻量级 Windows 桌面快捷启动器。搜索 + 面板双模式，AI 加持，语音输入，开源免费。

## 截图

![QuickStart](https://asset.localhost/screenshot.png)

## 功能

- **🔍 混合模式** — 搜索框 + 分类面板一键切换，模糊搜索应用和文件夹
- **📦 应用管理** — 自动扫描开始菜单/桌面/UWP/注册表，也支持拖拽 exe 添加
- **🤖 AI 自动分类** — 按开发/办公/浏览器/娱乐/设计/通讯/系统工具自动归类
- **📁 常用文件夹** — 面板中固定常用目录，一键直达
- **🎤 语音输入** — 点击麦克风，说出应用名即可搜索启动
- **🧮 内联计算器** — 搜索框直接输入算式，即时出结果
- **💬 AI 对话** — 内置 AI 聊天面板，支持 OpenAI / Claude / Ollama / 自定义 API
- **🎨 主题切换** — 浅色/深色/跟随系统
- **⚡ 超级轻量** — 安装包仅 4-5MB，内存占用 < 50MB
- **🖥️ 系统托盘** — Alt+Space 全局热键呼出，后台常驻

## 快速开始

### 下载安装

从 [Releases](https://github.com/wangneal/QuickStart/releases) 下载最新安装包：

| 格式 | 大小 | 适用场景 |
|------|:----:|----------|
| `QuickStart_*_x64-setup.exe` | ~4MB | NSIS 安装包，推荐 |
| `QuickStart_*_x64_en-US.msi` | ~5.5MB | MSI 安装包 |

安装后按 `Alt+Space` 呼出启动器。

### 从源码构建

```bash
# 环境要求：Node.js 20+，Rust stable，pnpm 10+
pnpm install
pnpm tauri dev    # 开发模式
pnpm tauri build  # 生产构建
```

## 配置 AI

在设置面板中配置：

| 提供商 | API Key | Base URL | 模型 |
|--------|---------|----------|------|
| OpenAI | 需要 | - | gpt-4o-mini |
| Claude | 需要 | - | claude-sonnet-4 |
| Ollama | 不需要 | http://localhost:11434 | llama3.2 |
| 自定义 | 需要 | 你的地址 | 你的模型 |

## 技术栈

```
前端:     React 19 + TypeScript + Tailwind CSS + shadcn/ui
桌面:     Tauri v2 (Rust)
搜索:     fuse.js
存储:     SQLite (rusqlite)
语音:     Web Speech API
AI:       reqwest + SSE streaming
```

## 构建产出

| 产物 | 路径 |
|------|------|
| 可执行文件 | `src-tauri/target/release/quickstart.exe` |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/` |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/` |

## 开源协议

MIT
