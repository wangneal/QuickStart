import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Fuse from "fuse.js";
import { invoke } from "./lib/utils";
import { useStore, type AppItem } from "./store";
import AIChat from "./AIChat";
import SettingsPanel from "./Settings";

import {
  Search, Mic, Settings, X, Minus, Maximize2, Folder, Trash2, Pin, ScanLine,
  ExternalLink, Calculator, LayoutGrid, List, Plus, FolderPlus, FileType, Bot,
} from "lucide-react";

// ---------- 工具函数 ----------
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return <>{text.slice(0,idx)}<mark className="bg-primary/20 text-foreground rounded px-0.5">{text.slice(idx,idx+query.length)}</mark>{text.slice(idx+query.length)}</>;
}

function safeEval(expr: string): number | null {
  const s = expr.replace(/×/g,"*").replace(/÷/g,"/").replace(/\s/g,"").replace(/[^0-9+\-*/.()%]/g,"");
  if (!s || /^[+\-*/]/.test(s)) return null;
  try { const r = Function(`"use strict"; return (${s})`)(); if (typeof r === "number" && isFinite(r)) return r; } catch {}
  return null;
}

class SpeechManager {
  private r: SpeechRecognition | null = null;
  constructor(private onResult: (t: string)=>void, private onEnd: ()=>void) {}
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onEnd(); return; }
    this.r = new SR(); this.r.lang = "zh-CN"; this.r.continuous = false; this.r.interimResults = false; this.r.maxAlternatives = 1;
    this.r.onresult = (e) => this.onResult(e.results[0][0].transcript);
    this.r.onend = () => this.onEnd(); this.r.onerror = () => this.onEnd();
    try { this.r.start(); } catch { this.onEnd(); }
  }
  stop() { if (this.r) { try { this.r.stop(); } catch {} this.r = null; } this.onEnd(); }
}

interface FolderItem { id: number; name: string; path: string; sort_order: number; }

export default function App() {
  const { searchQuery, setSearchQuery, apps, setApps, isListening, setListening } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"search" | "panel">("search");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [cm, setCm] = useState<{x:number;y:number;app:AppItem}|null>(null);
  const [calcResult, setCalcResult] = useState<string|null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const speechRef = useRef<SpeechManager|null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [activeCategory, setActiveCategory] = useState("全部");
  const [showSettings, setShowSettings] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [iconCache, setIconCache] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<{msg:string;type:"ok"|"err"} | null>(null);
const [fileResults, setFileResults] = useState<Array<{name:string;path:string;is_dir:boolean}>>([]);

  const showToast = (msg:string, type:"ok"|"err"="ok") => {
    setToast({msg,type});
    setTimeout(() => setToast(null), 3000);
  };
  const [folderName, setFolderName] = useState("");
  const [folderPath, setFolderPath] = useState("");

  // 数据加载
  const loadApps = useCallback(async () => {
    try { const list = await invoke<AppItem[]>("get_app_list"); if (list) setApps(list); } catch {}
  }, [setApps]);
  const loadFolders = useCallback(async () => {
    try { const list = await invoke<FolderItem[]>("get_folder_list"); if (list) setFolders(list); } catch {}
  }, []);
  const doScan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await invoke<{apps:any[];new_count:number}>("scan_apps");
      await invoke("classify_uncategorized");
      try { await invoke("ai_classify_apps"); } catch {}
      await loadApps();
      showToast(`扫描完成，新增 ${r.new_count} 个应用${r.new_count > 0 ? ' 🎉' : ''}`, "ok");
    } catch { showToast("扫描失败", "err"); }
    finally { setScanning(false); }
  }, [loadApps]);

  // 版本更新检查
  useEffect(() => {
    invoke<string>("check_update").then(v => {
      if (v && v !== "v0.1.0") showToast(`有新版本: ${v}`, "ok");
    }).catch(() => {});
  }, []);

  // 主题初始化
  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then(t => {
      if (t === "dark") document.documentElement.classList.add("dark");
      else if (t === "light") document.documentElement.classList.remove("dark");
      else document.documentElement.classList.remove("dark");
    }).catch(() => {});
  }, []);

  useEffect(() => { loadApps().then(() => { if (apps.length === 0) doScan(); }); loadFolders(); }, []);
  useEffect(() => { inputRef.current?.focus(); }, [view]);

  // 文件搜索（输入至少 2 个字符后触发）
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setFileResults([]); return; }
    const timer = setTimeout(async () => {
      try { const r = await invoke<any[]>("search_files", { query: q }); setFileResults(r); } catch {}
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  useEffect(() => { const h = () => setCm(null); window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);

  // 分类
  const categories = useMemo(() => {
    const cats = new Set<string>();
    apps.forEach(a => cats.add(a.category || "其他"));
    return ["全部", ...Array.from(cats).sort()];
  }, [apps]);

  const filteredByCategory = useMemo(() => {
    if (activeCategory === "全部") return apps;
    return apps.filter(a => (a.category || "其他") === activeCategory);
  }, [apps, activeCategory]);

  // 搜索
  const fuse = useMemo(() => new Fuse(apps, { keys: ["name","path","category"], threshold: 0.4, distance: 100, minMatchCharLength: 1 }), [apps]);
  const isCalcQuery = /^[\d+\-*/().%×÷\s]+$/.test(searchQuery.trim()) && searchQuery.trim().length > 1;
  const searchedApps = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return filteredByCategory;
    if (isCalcQuery) return [];
    return fuse.search(q).map(r => r.item);
  }, [searchQuery, filteredByCategory, fuse, isCalcQuery]);

  // 搜索文件夹也纳入结果
  const searchedFolders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return view === "panel" ? folders : [];
    return folders.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [searchQuery, folders, view]);

  // 计算器
  useEffect(() => {
    if (isCalcQuery) { const r = safeEval(searchQuery.trim()); setCalcResult(r !== null ? `= ${r}` : null); setShowCalc(r !== null); }
    else { setCalcResult(null); setShowCalc(false); }
  }, [searchQuery, isCalcQuery]);

  const displayItems = useMemo(() => {
    const items: Array<{type:"app"|"folder"|"file"|"calc";item:any}> = [];
    if (showCalc && calcResult) items.push({type:"calc", item:{label:calcResult}});
    searchedFolders.forEach(f => items.push({type:"folder", item:f}));
    searchedApps.forEach(a => items.push({type:"app", item:a}));
    fileResults.forEach(f => {
      if (!searchQuery.trim()) return;
      items.push({type:"file", item:f});
    });
    return items;
  }, [searchedApps, searchedFolders, fileResults, showCalc, calcResult, searchQuery]);

  // 按键
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex(i => Math.min(i+1, displayItems.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter") {
      const item = displayItems[selectedIndex];
      if (item?.type === "app") launchApp(item.item);
      else if (item?.type === "folder") openFolder(item.item.path);
      else if (item?.type === "file") openFile(item.item.path);
    } else if (e.key === "Escape") {
      if (searchQuery) setSearchQuery(""); else hideWindow();
    }
  };

  const launchApp = async (app: AppItem) => {
    try {
      invoke("record_app_launch", {id: app.id}).catch(()=>{});
      const {open} = await import("@tauri-apps/plugin-shell");
      await open(app.path);
      const w = await import("@tauri-apps/api/window");
      await w.getCurrentWindow().hide();
    } catch {}
  };
  const openFolder = async (path: string) => {
    try { const {open} = await import("@tauri-apps/plugin-shell"); await open(path); } catch {}
  };
  const openFile = async (path: string) => {
    try { const {open} = await import("@tauri-apps/plugin-shell"); await open(path); } catch {}
  };
  // ---------- 拖拽分类（HTML5 原生） ----------
  const [dragAppId, setDragAppId] = useState<number | null>(null);
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);

  const onDragStart = (appId: number) => { setDragAppId(appId); };

  const onDragOverTab = (e: React.DragEvent, cat: string) => {
    e.preventDefault();
    setDragOverCat(cat);
  };

  const onDragLeaveTab = () => { setDragOverCat(null); };

  const onDropOnTab = (e: React.DragEvent, cat: string) => {
    e.preventDefault();
    setDragOverCat(null);
    if (dragAppId !== null && cat && cat !== "全部") {
      invoke("update_app_category", { id: dragAppId, category: cat }).then(() => loadApps()).catch(() => {});
      setDragAppId(null);
    }
  };

  const onDragEnd = () => { setDragAppId(null); setDragOverCat(null); };

  const hideWindow = async () => {
    const w = await import("@tauri-apps/api/window"); await w.getCurrentWindow().hide();
  };
  const minimizeWindow = async () => {
    const w = await import("@tauri-apps/api/window"); await w.getCurrentWindow().minimize();
  };
  const toggleMaximize = async () => {
    const w = await import("@tauri-apps/api/window");
    const win = w.getCurrentWindow();
    const isMax = await win.isMaximized();
    if (isMax) { await win.unmaximize(); setMaximized(false); }
    else { await win.maximize(); setMaximized(true); }
  };

  // 语音
  const toggleListening = () => {
    if (isListening) { speechRef.current?.stop(); setListening(false); return; }
    const m = new SpeechManager(t => { setSearchQuery(t); setListening(false); setView("search"); inputRef.current?.focus(); }, () => setListening(false));
    speechRef.current = m; m.start(); setListening(true);
  };

  // 应用操作
  const loadIcon = async (appId: number) => {
    if (iconCache[appId]) return;
    try {
      const dataUrl = await invoke<string>("get_app_icon", { appId });
      setIconCache(prev => ({ ...prev, [appId]: dataUrl }));
    } catch {}
  };

  useEffect(() => {
    // 懒加载前 20 个应用的图标
    const toLoad = filteredByCategory.slice(0, 20).filter(a => !iconCache[a.id]);
    toLoad.forEach(a => loadIcon(a.id));
  }, [filteredByCategory]);

  const removeApp = async (id: number) => { try { await invoke("remove_app", {id}); await loadApps(); } catch {} setCm(null); };
  const togglePin = async (id: number) => { try { await invoke("toggle_pin_app", {id}); await loadApps(); } catch {} setCm(null); };
  const updateCategory = async (id: number, category: string) => { try { await invoke("update_app_category", {id, category}); await loadApps(); } catch {} setCm(null); };

  const addFolder = async () => {
    if (!folderName || !folderPath) return;
    try { await invoke("add_folder", {name: folderName, path: folderPath}); await loadFolders(); setShowFolderInput(false); setFolderName(""); setFolderPath(""); } catch {}
  };
  const removeFolder = async (id: number) => { try { await invoke("remove_folder", {id}); await loadFolders(); } catch {} };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.name.endsWith(".exe") || file.name.endsWith(".lnk")) {
        const name = file.name.replace(/\.(exe|lnk)$/i,"");
        const path = (file as any).path || file.name;
        try { await invoke("add_app", {name, path}); } catch {}
      }
    }
    await loadApps();
  };

  // 分类对话框
  const [catDialog, setCatDialog] = useState<AppItem|null>(null);
  const [catInput, setCatInput] = useState("");

  return (
    <div className="h-screen w-screen flex flex-col bg-background/95 backdrop-blur-xl rounded-2xl overflow-hidden border border-border shadow-2xl" onContextMenu={e=>e.preventDefault()} onDrop={handleDrop} onDragOver={e=>e.preventDefault()}>
      {/* 标题栏 */}
      <div className="titlebar flex items-center justify-between px-4 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">QuickStart</span>
          <div className="flex bg-muted rounded-lg p-0.5">
            <button onClick={() => setView("search")} className={`px-2.5 py-1 text-xs rounded-md transition-colors ${view==="search" ? "bg-background shadow-sm" : "hover:text-foreground text-muted-foreground"}`}>
              <Search className="w-3.5 h-3.5 inline mr-1" />搜索
            </button>
            <button onClick={() => setView("panel")} className={`px-2.5 py-1 text-xs rounded-md transition-colors ${view==="panel" ? "bg-background shadow-sm" : "hover:text-foreground text-muted-foreground"}`}>
              <LayoutGrid className="w-3.5 h-3.5 inline mr-1" />面板
            </button>
          </div>
        </div>
        <div className="titlebar-button flex items-center gap-1">
          <button onClick={() => setShowAIChat(!showAIChat)} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="AI 助手">
            <Bot className="w-4 h-4" />
          </button>
          <button onClick={doScan} disabled={scanning} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50" title="扫描并分类">
            <ScanLine className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />
          </button>
          <button onClick={minimizeWindow} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="最小化">
            <Minus className="w-4 h-4" />
          </button>
          <button onClick={toggleMaximize} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title={maximized ? "还原" : "最大化"}>
            <Maximize2 className="w-4 h-4" />
          </button>
          <button onClick={() => setShowSettings(true)} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="设置">
            <Settings className="w-4 h-4" />
          </button>
          <button onClick={hideWindow} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title="隐藏">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="px-4 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <input ref={inputRef} type="text" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setSelectedIndex(0); }} onKeyDown={handleKeyDown}
            placeholder="搜索应用、文件夹，或输入算式..." className="w-full h-11 pl-10 pr-12 rounded-xl bg-secondary border border-border focus:outline-none focus:ring-2 focus:ring-ring text-foreground placeholder:text-muted-foreground text-base" />
          <button onClick={toggleListening} className={`absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${isListening ? "bg-destructive text-destructive-foreground animate-pulse" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`} title="语音输入">
            <Mic className="w-4 h-4" />
          </button>
        </div>
        {isListening && <div className="mt-1 text-xs text-center text-muted-foreground animate-pulse">正在聆听...</div>}
      </div>

      {/* 常用应用（面板模式 + 无搜索时显示） */}
      {view === "panel" && !searchQuery.trim() && (
        (() => {
          const topApps = [...apps].sort((a,b) => b.use_count - a.use_count).slice(0, 8).filter(a => a.use_count > 0);
          if (topApps.length === 0) return null;
          return (
            <div className="px-4 pb-2">
              <span className="text-xs font-medium text-muted-foreground mb-1.5 block">常用应用</span>
              <div className="flex gap-1.5 overflow-x-auto scrollbar-none pb-0.5">
                {topApps.map(app => (
                  <button key={app.id} onClick={() => launchApp(app)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-accent shrink-0 transition-colors">
                    <div className="w-5 h-5 rounded overflow-hidden bg-muted flex items-center justify-center text-[10px] font-bold shrink-0">
                      {iconCache[app.id]
                        ? <img src={iconCache[app.id]} alt="" className="w-full h-full object-contain" />
                        : <span>{app.name.charAt(0)}</span>}
                    </div>
                    <span className="text-xs whitespace-nowrap">{highlight(app.name, searchQuery)}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })()
      )}

      {/* 面板：分类标签 */}
      {/* 面板：分类标签（可拖放） */}
      {view === "panel" && !searchQuery.trim() && (
        <div className="px-4 pb-2 overflow-x-auto scrollbar-none">
          <div className="flex gap-1.5">
            {categories.filter(c => c !== "全部").map(cat => (
              <div key={cat} className="relative"
                onDragOver={e => onDragOverTab(e, cat)}
                onDragLeave={onDragLeaveTab}
                onDrop={e => onDropOnTab(e, cat)}>
                <div className={`whitespace-nowrap px-3 py-1.5 text-xs rounded-full transition-all ${activeCategory === cat ? "bg-primary text-primary-foreground" : dragOverCat === cat && dragAppId ? "ring-2 ring-primary bg-secondary" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {cat}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* 扫描中状态 */}
        {scanning && apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <ScanLine className="w-12 h-12 mb-3 opacity-20 animate-spin" />
            <p className="text-sm">正在扫描并分类应用...</p>
          </div>
        ) : displayItems.length === 0 && !searchQuery.trim() && view === "panel" ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <LayoutGrid className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">该分类暂无应用</p>
          </div>
        ) : displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Search className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">{searchQuery ? "未找到匹配项" : "还没有应用"}</p>
            <p className="text-xs mt-1">拖拽 exe 到这里添加</p>
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            {displayItems.map((item, idx) => {
              if (item.type === "calc") return (
                <div key="calc" className={`col-span-5 flex items-center gap-3 p-3 rounded-xl transition-all ${idx === selectedIndex ? "bg-accent ring-2 ring-ring" : "bg-muted/50"}`}>
                  <Calculator className="w-5 h-5 text-primary" />
                  <span className="text-lg font-mono font-bold text-foreground">{item.item.label}</span>
                </div>
              );
              if (item.type === "file") {
                const f = item.item as {name:string;path:string;is_dir:boolean};
                return (
                  <button key={`file-${f.path}`} onClick={() => openFile(f.path)}
                    className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"}`}>
                    <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                      <Folder className="w-7 h-7 text-blue-500" />
                    </div>
                    <span className="text-xs text-center text-muted-foreground truncate w-full">{f.name}</span>
                    <span className="text-[9px] text-muted-foreground/50 truncate w-full">{f.is_dir ? "文件夹" : "文件"}</span>
                  </button>
                );
              }
              if (item.type === "folder") {
                const f = item.item as FolderItem;
                return (
                  <button key={`f-${f.id}`} onClick={() => openFolder(f.path)}
                    className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"}`}
                    onContextMenu={e => { e.preventDefault(); }}>
                    <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                      <Folder className="w-7 h-7 text-amber-500" />
                    </div>
                    <span className="text-xs text-center text-muted-foreground truncate w-full">{f.name}</span>
                  </button>
                );
              }
              const app = item.item as AppItem;
              return (
                <button key={app.id}
                  draggable
                  onDragStart={() => onDragStart(app.id)}
                  onDragEnd={onDragEnd}
                  onClick={() => launchApp(app)}
                  onContextMenu={e => { e.preventDefault(); setCm({x:e.clientX, y:e.clientY, app}); }}
                  className={`relative flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"} ${dragAppId === app.id ? "opacity-40" : ""}`}>
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-secondary flex items-center justify-center">
                    {iconCache[app.id]
                      ? <img src={iconCache[app.id]} alt={app.name} className="w-full h-full object-contain" />
                      : <span className="text-lg font-bold text-foreground">{app.name.charAt(0)}</span>}
                  </div>
                  <span className="text-xs text-center text-muted-foreground truncate w-full leading-tight">{highlight(app.name, searchQuery)}</span>
                  <span className="text-[9px] text-muted-foreground/50 truncate w-full">{app.category}</span>
                  {app.is_pinned && <Pin className="absolute top-1 right-1 w-3 h-3 text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 文件夹区域 - 面板视图底部 */}
      {view === "panel" && !searchQuery.trim() && (
        <div className="px-4 pb-3 pt-1 border-t border-border">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-muted-foreground">常用文件夹</span>
            <button onClick={() => setShowFolderInput(!showFolderInput)} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
              <FolderPlus className="w-4 h-4" />
            </button>
          </div>
          {showFolderInput && (
            <div className="flex flex-col gap-1.5 mb-2">
              <input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="名称" className="h-8 px-2 rounded-lg bg-secondary text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring" />
              <input value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder="路径 (如 C:\Users\...)" className="h-8 px-2 rounded-lg bg-secondary text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring" />
              <div className="flex gap-1">
                <button onClick={addFolder} className="flex-1 h-7 rounded-lg bg-primary text-primary-foreground text-xs">添加</button>
                <button onClick={() => setShowFolderInput(false)} className="h-7 px-3 rounded-lg bg-secondary text-xs text-muted-foreground">取消</button>
              </div>
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto scrollbar-none pb-0.5">
            {folders.map(f => (
              <button key={f.id} onClick={() => openFolder(f.path)} onContextMenu={e => { e.preventDefault(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-accent transition-colors shrink-0 group">
                <Folder className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs text-foreground">{f.name}</span>
                <Trash2 onClick={e => { e.stopPropagation(); removeFolder(f.id); }} className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity" />
              </button>
            ))}
            {folders.length === 0 && <span className="text-xs text-muted-foreground">还没有常用文件夹</span>}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {cm && (
        <div className="fixed z-50 w-44 rounded-lg border border-border bg-popover p-1 shadow-xl" style={{left: cm.x, top: cm.y}}>
          <button onClick={() => { launchApp(cm.app); setCm(null); }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><ExternalLink className="w-4 h-4" />启动</button>
          <button onClick={() => togglePin(cm.app.id)} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><Pin className="w-4 h-4" />{cm.app.is_pinned ? "取消固定" : "固定到顶部"}</button>
          <button onClick={() => { setCatDialog(cm.app); setCatInput(cm.app.category); setCm(null); }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><FileType className="w-4 h-4" />修改分类</button>
          <button onClick={async () => {
            try { const {open} = await import("@tauri-apps/plugin-shell"); const p = cm.app.path; const d = p.substring(0, p.lastIndexOf("\\")); if (d) await open(d); } catch {} setCm(null);
          }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><Folder className="w-4 h-4" />打开所在文件夹</button>
          <div className="h-px bg-border my-1" />
          <button onClick={() => removeApp(cm.app.id)} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-destructive/10 text-destructive"><Trash2 className="w-4 h-4" />删除</button>
        </div>
      )}

      {/* 修改分类对话框 */}
      {catDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setCatDialog(null)}>
          <div className="w-64 p-4 rounded-xl bg-popover border border-border shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-medium mb-2">修改分类 - {catDialog.name}</h3>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {categories.filter(c => c !== "全部").map(cat => (
                <button key={cat} onClick={() => { updateCategory(catDialog.id, cat); setCatDialog(null); }}
                  className={`px-2.5 py-1 text-xs rounded-full ${cat === (catDialog?.category||"其他") ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {cat}
                </button>
              ))}
            </div>
            <input value={catInput} onChange={e => setCatInput(e.target.value)} placeholder="输入新分类名称..." className="w-full h-8 px-2 rounded-lg bg-secondary text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring mb-2" />
            <button onClick={() => { if (catInput.trim()) updateCategory(catDialog.id, catInput.trim()); setCatDialog(null); }} className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs">确认</button>
          </div>
        </div>
      )}

      {/* AI 对话面板 */}
      {showAIChat && <AIChat onClose={() => setShowAIChat(false)} />}

      {/* 设置面板 */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Toast 通知 */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl bg-popover border border-border shadow-lg text-sm animate-in fade-in slide-in-from-bottom-2">
          <span className={toast.type === "err" ? "text-destructive" : "text-foreground"}>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
