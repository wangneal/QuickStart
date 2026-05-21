# 新建分类功能设计

日期：2026-05-21

## 背景

QuickStart 当前的分类不是独立实体，而是从 `apps.category` 动态汇总：前端通过应用列表生成分类标签，后端 `get_categories` 使用 `SELECT DISTINCT category FROM apps`。这导致用户无法创建“空分类”，只能先把某个应用改到一个新分类名下，分类才会出现。

本设计为应用面板增加真正的“新建分类”能力：用户可以在分类栏直接创建分类，即使分类下暂时没有应用，也能持久显示。

## 目标

- 在面板模式分类栏提供 `+ 分类` 操作入口。
- 支持创建空分类，并在重启后保留。
- 保持现有应用分类逻辑兼容，已有 `apps.category` 数据不丢失。
- 新建成功后自动切换到新分类，并显示“该分类暂无应用”。
- 对空名称、重复名称给出明确反馈。

## 非目标

- 本阶段不实现分类删除。
- 本阶段不实现分类重命名。
- 本阶段不实现分类排序拖拽。
- 本阶段不迁移应用分类外键；`apps.category` 继续保存分类名称字符串。

## 推荐方案

采用“新增 `categories` 表 + 分类并集查询”的轻量持久化方案。

### 为什么选择该方案

相比只在前端保存分类，它能解决重启丢失问题；相比完整外键化分类系统，它改动更小，不需要重构现有应用扫描、自动分类、AI 分类和手动修改分类流程。它既满足当前需求，也为后续删除、重命名、排序分类留下清晰扩展点。

## 数据设计

新增 SQLite 表：

```sql
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

启动初始化时继续创建现有表，并新增 `categories` 表。为兼容旧数据，初始化后执行一次同步：把 `apps.category` 中非空、非 `全部` 的分类名插入 `categories`，使用 `INSERT OR IGNORE` 避免重复。

`apps.category` 暂时保持字符串字段，不增加外键约束。这样现有扫描器、分类器和 AI 分类代码无需大规模改造。

## 后端命令设计

### `get_categories`

改为返回 `categories.name` 与 `apps.category` 的并集，确保两类分类都能显示：

- 新建但暂无应用的空分类；
- 旧数据或自动分类刚写入的应用分类。

结果应去重、按 `sort_order` 和名称排序，并排除空字符串。

### `add_category(name)`

新增 Tauri 命令：

- 输入：`name: String`
- 行为：trim 后插入 `categories`。
- 校验：
  - 空名称返回错误：`分类名称不能为空`
  - `全部` 为保留名称，返回错误：`不能使用保留分类名称`
  - 重复名称返回错误：`分类已存在`
- 成功：返回创建后的分类名称。

### `update_app_category`

保留现有签名，增加一个兼容性副作用：当用户手动把应用改到一个新分类名时，同步 `INSERT OR IGNORE` 到 `categories` 表。这样“修改分类”弹窗中直接输入的新分类也会成为持久分类。

### 命令注册

在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 中注册 `commands::add_category`。

## 前端设计

### 状态

当前 `categories` 由 `apps` 派生。新增分类后必须能显示空分类，因此前端增加独立分类状态：

- `categories: string[]`
- `loadCategories()` 调用后端 `get_categories`
- 启动、扫描完成、修改应用分类、新建分类后刷新分类列表

为避免和“全部”混淆，前端渲染时组合 `['全部', ...categories]`。

### UI 入口

位置：面板模式、无搜索词时的分类标签栏右侧。

交互：

1. 分类标签列表末尾显示一个小按钮：`+ 分类`。
2. 点击后在分类栏下方或居中弹出小输入框。
3. 输入分类名后点击“创建”或按 Enter。
4. 成功后：
   - 调用 `add_category`；
   - 刷新分类列表；
   - 设置 `activeCategory` 为新分类；
   - 显示 toast：`已创建分类：xxx`。
5. 失败后显示后端错误 toast。

### 现有“修改分类”弹窗

分类候选按钮改用独立分类列表，而不是只从应用列表派生。用户仍然可以在输入框中直接输入一个新分类名；当成功修改到新分类时，前端应刷新分类列表，确保新分类被持久写入或至少从应用分类并集中出现。

## 数据流

### 新建分类

```text
用户点击 + 分类
  → 输入名称
  → 前端 invoke("add_category", { name })
  → 后端校验并写入 categories
  → 前端 loadCategories()
  → setActiveCategory(name)
  → 面板显示空分类状态
```

### 修改应用分类

```text
用户右键应用 → 修改分类
  → invoke("update_app_category")
  → loadApps()
  → loadCategories()
  → 分类标签保持同步
```

## 错误处理

- 分类名为空：前端阻止提交，后端也返回错误。
- 分类名重复：后端返回 `分类已存在`，前端 toast 展示。
- 数据库写入失败：保留原错误日志，并向用户显示 `创建分类失败` 或具体错误。
- 当前活动分类被刷新后不存在：回退到 `全部`。本阶段正常不会发生，但可作为防御性处理。

## 测试与验证

实现后运行：

- `cargo check`
- `pnpm exec tsc --noEmit`

手动验证：

1. 面板模式点击 `+ 分类`，输入 `测试分类`。
2. 分类标签中立即出现 `测试分类`。
3. 自动切换到 `测试分类`，内容区显示“该分类暂无应用”。
4. 重启应用后 `测试分类` 仍存在。
5. 重复创建 `测试分类` 时提示 `分类已存在`。
6. 右键应用修改到 `测试分类` 后，应用出现在该分类下。

## 后续扩展

- 分类重命名：更新 `categories.name`，同时批量更新 `apps.category`。
- 分类删除：删除空分类；非空分类需要提示迁移或归入 `未分类`。
- 分类排序：使用 `sort_order` 支持拖拽排序。
