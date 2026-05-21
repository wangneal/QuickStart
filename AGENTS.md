# QuickStart

## Project

Lightweight Windows desktop quick-launcher built with Tauri v2 + React + TypeScript.
Features: hybrid search bar + app panel, app scanning, AI auto-categorization, AI chat, voice input, folder management.

## GSD Workflow

This project uses the GSD (Get Shit Done) workflow.

- **Planning docs**: `.planning/` (gitignored, local only)
- **Config**: `.planning/config.json`
- **Project context**: `.planning/PROJECT.md`
- **Requirements**: `.planning/REQUIREMENTS.md`
- **Roadmap**: `.planning/ROADMAP.md`
- **State**: `.planning/STATE.md`

### Workflow commands

- `/gsd-progress` — Check current status
- `/gsd-plan-phase <N>` — Plan a phase
- `/gsd-execute-phase <N>` — Execute planned phase
- `/gsd-verify-work <N>` — Verify phase completion
- `/gsd-ship` — Create PR and prepare for merge

### Phase progression

Phase 1: 基础壳层 ✅ Complete (Tauri + window + tray + hotkey + SQLite)
Phase 2: 应用扫描与管理 ✅ Complete (auto-scan + manual add + icons)
Phase 3: 搜索 + 语音 ✅ Complete (fuzzy search + Web Speech API)
Phase 4: 应用面板 + 文件夹 ✅ Complete (grid panel + AI classification + folders)
Phase 5: AI 对话 + 整理 ✅ Complete (chat + folder organization, multi-API)
Phase 6: 设置 + 发布 ⚠️ Partial (settings done, installer + CI/CD pending)

Current phase: All phases implemented (v1.0). Settings UI complete, installer and CI/CD pipeline remain.
