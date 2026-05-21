import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "./lib/utils";
import { useStore, type AppItem } from "./store";
import AIChat from "./AIChat";
import SettingsPanel from "./Settings";

import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  Search, Mic, Settings, X, Minus, Maximize2, Folder, Trash2, Pin, ScanLine,
  ExternalLink, Calculator, LayoutGrid, List, Plus, FolderPlus, FileType, Bot, Clock,
} from "lucide-react";

// ---------- 工具函数 ----------
// 分词：按空格、连字符、点号、驼峰分割
const tokenize = (s: string): string[] => {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_.]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.toLowerCase());
};

// 常见缩写映射
const ABBREVIATIONS: Record<string, string[]> = {
  'vs': ['visual studio'],
  'vscode': ['visual studio code'],
  'vsc': ['visual studio code'],
  'ps': ['powershell', 'photoshop'],
  'edge': ['microsoft edge'],
  'ie': ['internet explorer'],
  'cmd': ['command prompt'],
  'wsl': ['windows subsystem linux'],
  'npp': ['notepad++'],
  'fnm': ['firefox nightly'],
  'wt': ['windows terminal'],
  'reg': ['registry editor', 'regedit'],
  'calc': ['calculator'],
};

const AppCard = memo(function AppCard({ app, idx, selectedIndex, dragAppId, searchQuery, iconCache, onDragStart, onDragEnd, onClick, onContextMenu }: {
  app: AppItem; idx: number; selectedIndex: number; dragAppId: number | null;
  searchQuery: string; iconCache: Record<number,string>;
  onDragStart: (id:number)=>void; onDragEnd: ()=>void; onClick: (a:AppItem)=>void;
  onContextMenu: (a:AppItem, x:number, y:number)=>void;
}) {
  return (
    <button draggable onDragStart={() => onDragStart(app.id)} onDragEnd={onDragEnd}
      onClick={() => onClick(app)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(app, e.clientX, e.clientY); }}
      className={`relative flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"} ${dragAppId === app.id ? "opacity-40" : ""}`}>
      <div className="w-12 h-12 rounded-xl overflow-hidden bg-secondary flex items-center justify-center">
        {iconCache[app.id] && iconCache[app.id] !== "__failed__"
          ? <img src={iconCache[app.id]} alt={app.name} className="w-full h-full object-contain app-icon" />
          : <span className="text-lg font-bold text-foreground">{app.name.charAt(0)}</span>}
      </div>
      <span className="text-xs text-center text-muted-foreground truncate w-full leading-tight">{highlight(app.name, searchQuery)}</span>
      <span className="text-[9px] text-muted-foreground/50 truncate w-full">{app.category}</span>
      {app.is_pinned && <Pin className="absolute top-1 right-1 w-3 h-3 text-primary" />}
    </button>
  );
});

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return <>{text}</>;
  const q = query.toLowerCase().trim();
  const tokens = tokenize(query);
  const textLower = text.toLowerCase();

  // 找出所有需要高亮的区间
  const ranges: [number, number][] = [];

  // 1. 直接子串匹配区间
  const directIdx = textLower.indexOf(q);
  if (directIdx !== -1) ranges.push([directIdx, directIdx + q.length]);

  // 2. 每个 token 的前缀匹配区间
  const nameTokens = tokenize(text);
  let offset = 0;
  for (const nt of nameTokens) {
    const startInOriginal = textLower.indexOf(nt, offset);
    if (startInOriginal !== -1) {
      for (const qt of tokens) {
        if (nt.startsWith(qt)) {
          ranges.push([startInOriginal, startInOriginal + qt.length]);
        }
      }
      offset = startInOriginal + nt.length;
    }
  }

  // 3. 缩写映射 — 全名高亮
  for (const [abbr, expansions] of Object.entries(ABBREVIATIONS)) {
    if (tokens.includes(abbr)) {
      for (const exp of expansions) {
        const expIdx = textLower.indexOf(exp);
        if (expIdx !== -1) ranges.push([expIdx, expIdx + exp.length]);
      }
    }
  }

  // 合并重叠区间
  if (ranges.length === 0) return <>{text}</>;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]];
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) { last[1] = Math.max(last[1], e); }
    else { merged.push([s, e]); }
  }

  // 构建高亮结果
  const parts: React.ReactNode[] = [];
  let lastEnd = 0;
  for (const [s, e] of merged) {
    if (s > lastEnd) parts.push(text.slice(lastEnd, s));
    parts.push(<mark key={s} className="bg-primary/20 text-foreground rounded px-0.5">{text.slice(s, e)}</mark>);
    lastEnd = e;
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd));
  return <>{parts}</>;
}

function safeEval(expr: string): number | null {
  const s = expr.replace(/×/g, "*").replace(/÷/g, "/").replace(/\s/g, "");
  if (!s) return null;

  // Tokenizer
  type Token = { type: 'num' | 'op'; value: string };
  const tokens: Token[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s[i];
    if (/\d/.test(c) || c === '.') {
      let num = '';
      let dotCount = 0;
      while (i < s.length && (/\d/.test(s[i]) || s[i] === '.')) {
        if (s[i] === '.') {
          dotCount++;
          if (dotCount > 1) return null;
        }
        num += s[i];
        i++;
      }
      if (num === '.' || num.endsWith('.')) return null;
      tokens.push({ type: 'num', value: num });
    } else if ('+-*/%()'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
    } else {
      return null;
    }
  }

  if (tokens.length === 0) return null;

  // Parser with proper precedence (recursive descent)
  let pos = 0;

  function parseExpr(): number | null { return parseAddSub(); }

  function parseAddSub(): number | null {
    let left = parseMulDiv();
    if (left === null) return null;
    while (pos < tokens.length) {
      const op = tokens[pos];
      if (op.type !== 'op' || (op.value !== '+' && op.value !== '-')) break;
      pos++;
      const right = parseMulDiv();
      if (right === null) return null;
      left = op.value === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv(): number | null {
    let left = parsePercent();
    if (left === null) return null;
    while (pos < tokens.length) {
      const op = tokens[pos];
      if (op.type !== 'op' || (op.value !== '*' && op.value !== '/')) break;
      pos++;
      const right = parsePercent();
      if (right === null) return null;
      if (op.value === '/') {
        if (right === 0) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parsePercent(): number | null {
    let left = parseUnary();
    if (left === null) return null;
    while (pos < tokens.length && tokens[pos].type === 'op' && tokens[pos].value === '%') {
      pos++;
      left = left / 100;
    }
    return left;
  }

  function parseUnary(): number | null {
    if (pos >= tokens.length) return parseAtom();
    const op = tokens[pos];
    if (op.type === 'op' && (op.value === '+' || op.value === '-')) {
      pos++;
      const operand = parseUnary();
      if (operand === null) return null;
      return op.value === '-' ? -operand : operand;
    }
    return parseAtom();
  }

  function parseAtom(): number | null {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];
    if (tok.type === 'num') {
      pos++;
      return parseFloat(tok.value);
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos++;
      const val = parseExpr();
      if (val === null || pos >= tokens.length || tokens[pos].value !== ')') return null;
      pos++;
      return val;
    }
    return null;
  }

  const result = parseExpr();
  if (result === null || pos < tokens.length) return null;
  if (typeof result !== 'number' || !isFinite(result)) return null;
  return result;
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
  stop() { if (this.r) { try { this.r.stop(); } catch (e) { console.warn("speech stop:", e); } this.r = null; } this.onEnd(); }
}

interface FolderItem { id: number; name: string; path: string; category: string; sort_order: number; }
interface FileResult { name: string; path: string; is_dir: boolean; }
interface ScanAppsResult { apps: AppItem[]; new_count: number; }
interface DroppedFile extends File { path?: string; }

type DisplayItem =
  | { type: "app"; item: AppItem }
  | { type: "folder"; item: FolderItem }
  | { type: "file"; item: FileResult }
  | { type: "calc"; item: { label: string } };

export default function App() {
  const { searchQuery, setSearchQuery, apps, setApps, isListening, setListening } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<"search" | "panel" | "folders">("search");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [cm, setCm] = useState<{x:number;y:number;app:AppItem}|null>(null);
  const [calcResult, setCalcResult] = useState<string|null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const speechRef = useRef<SpeechManager|null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState("全部");
  const [folderCategories, setFolderCategories] = useState<string[]>([]);
  const [activeFolderCategory, setActiveFolderCategory] = useState("全部");
  const [showSettings, setShowSettings] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [newFolderCategory, setNewFolderCategory] = useState("未分类");
  const [folderCm, setFolderCm] = useState<{ x: number; y: number; folder: FolderItem } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [iconCache, setIconCache] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<{msg:string;type:"ok"|"err"} | null>(null);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  const showToast = (msg:string, type:"ok"|"err"="ok") => {
    setToast({msg,type});
    setTimeout(() => setToast(null), 3000);
  };
  const [folderName, setFolderName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  // 数据加载
  const loadApps = useCallback(async () => {
    try { const list = await invoke<AppItem[]>("get_app_list"); if (list) setApps(list); } catch (e) { console.warn("loadApps:", e); }
  }, [setApps]);
  const loadFolders = useCallback(async () => {
    try {
      const list = await invoke<FolderItem[]>("get_folder_list");
      setFolders(list);
    } catch (e) {
      console.error("Failed to load folders:", e);
    }
  }, []);

  const loadFolderCategories = useCallback(async () => {
    try {
      const cats = await invoke<string[]>("get_folder_categories");
      setFolderCategories(cats);
    } catch (e) {
      console.error("Failed to load folder categories:", e);
    }
  }, []);
  const loadCategories = useCallback(async () => {
    try {
      const list = await invoke<string[]>("get_categories");
      setCategoryNames(list.filter(c => c.trim() && c !== "全部"));
    } catch (e) {
      console.warn("loadCategories:", e);
    }
  }, []);
  const doScan = useCallback(async () => {
    setScanning(true);
    try {
      await invoke<ScanAppsResult>("scan_apps");
    } catch (e) {
      console.warn("scan_apps:", e);
      showToast("扫描失败", "err");
    } finally {
      setScanning(false);
    }
  }, []);

  // 版本更新检查
  useEffect(() => {
    invoke<string>("check_update").then(v => {
      if (v && v !== "v0.1.0") showToast(`有新版本: ${v}`, "ok");
    }).catch(e => { if (e !== "无法连接 GitHub") console.warn("update check:", e); });
  }, []);

  // 主题初始化
  useEffect(() => {
    invoke<string>("get_setting", { key: "theme" }).then(t => {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (t === "dark" || (t !== "light" && prefersDark)) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    }).catch(e => console.warn("theme init:", e));
  }, []);

  // 启动时：加载已有数据 → 判断是否需要自动扫描
  useEffect(() => {
    const init = async () => {
      await loadApps();
      await loadFolders();
      await loadCategories();
      // 加载搜索历史
      try { const h = await invoke<string[]>("get_search_history"); if (h) setSearchHistory(h); } catch (e) { console.warn("loadSearchHistory:", e); }
      // 检查是否需要扫描：DB 为空 或 超过 24 小时未扫描
      const lastScan = await invoke<string>("get_last_scan_time");
      const needScan = !lastScan || (Date.now() / 1000 - parseInt(lastScan, 10)) > 86400;
      if (needScan) {
        doScan(); // 后台静默扫描，不阻塞 UI
      }
    };
    init();
  }, [doScan, loadApps, loadFolders, loadCategories]);

  useEffect(() => {
    const onScanComplete = async (event: { payload: ScanAppsResult }) => {
      const r = event.payload;
      try { await invoke("classify_uncategorized"); } catch (e) { console.warn("classify_uncategorized:", e); }
      try { await invoke("ai_classify_apps"); } catch (e) { console.warn("ai classify skipped:", e); }
      await loadApps();
      await loadFolders();
      await loadCategories();
      setScanning(false);
      showToast(`扫描完成，新增 ${r.new_count} 个应用${r.new_count > 0 ? ' 🎉' : ''}`, "ok");
    };
    const unlistenPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen("scan-complete", onScanComplete)
    );
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [loadApps, loadFolders, loadCategories]);
  useEffect(() => { inputRef.current?.focus(); }, [view]);

  // 文件搜索（输入至少 2 个字符后触发）
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setFileResults([]); return; }
    const timer = setTimeout(async () => {
      try { const r = await invoke<FileResult[]>("search_files", { query: q }); setFileResults(r); } catch (e) { console.warn("search_files:", e); setFileResults([]); }
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  useEffect(() => { const h = () => setCm(null); window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);

  // 分类
  const categories = useMemo(() => ["全部", ...categoryNames], [categoryNames]);

  const filteredByCategory = useMemo(() => {
    if (activeCategory === "全部") return apps;
    return apps.filter(a => (a.category || "其他") === activeCategory);
  }, [apps, activeCategory]);

  // 分词匹配搜索
  const matchSearch = (appName: string, appPath: string, appCategory: string, query: string): boolean => {
    const q = query.toLowerCase().trim();
    if (!q) return false;
    const nameLower = appName.toLowerCase();
    const pathLower = appPath.toLowerCase();
    const catLower = appCategory.toLowerCase();

    // 1. 直接子串匹配（最高优先级）
    if (nameLower.includes(q) || pathLower.includes(q) || catLower.includes(q)) return true;

    // 2. 分词匹配：每个查询 token 匹配名称中某个 token 的前缀
    const nameTokens = tokenize(appName);
    const queryTokens = tokenize(query);

    const allQueryTokensMatch = queryTokens.every(qt => {
      // 检查查询 token 是否匹配名称中某个 token 的前缀
      const matchesNameToken = nameTokens.some(nt => nt.startsWith(qt));
      if (matchesNameToken) return true;

      // 检查查询 token 是否匹配名称整体的前缀
      if (nameLower.startsWith(qt)) return true;

      // 检查路径/分类
      if (pathLower.includes(qt) || catLower.includes(qt)) return true;

      // 检查缩写映射
      const expanded = ABBREVIATIONS[qt];
      if (expanded) {
        return expanded.some(exp => nameLower.includes(exp) || pathLower.includes(exp));
      }

      return false;
    });

    if (allQueryTokensMatch) return true;

    // 3. 缩写反向匹配：名称可能包含缩写，查询包含全名
    for (const [abbr, expansions] of Object.entries(ABBREVIATIONS)) {
      if (nameLower.includes(abbr) || nameTokens.some(nt => nt === abbr)) {
        if (expansions.some(exp => queryTokens.some(qt => exp.includes(qt)))) {
          return true;
        }
      }
    }

    return false;
  };

  const isCalcQuery = /^[\d+\-*/().%×÷\s]+$/.test(searchQuery.trim()) && searchQuery.trim().length > 1;
  const searchedApps = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return view === "panel" ? filteredByCategory : [];
    if (isCalcQuery) return [];
    return apps.filter(a => matchSearch(a.name, a.path, a.category || "其他", q));
  }, [searchQuery, filteredByCategory, apps, isCalcQuery, view]);

  // 搜索文件夹也纳入结果（使用分词匹配）
  const searchedFolders = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return view === "panel" ? folders : [];
    return folders.filter(f => matchSearch(f.name, f.path, "", q));
  }, [searchQuery, folders, view]);

  // 计算器
  useEffect(() => {
    if (isCalcQuery) { const r = safeEval(searchQuery.trim()); setCalcResult(r !== null ? `= ${r}` : null); setShowCalc(r !== null); }
    else { setCalcResult(null); setShowCalc(false); }
  }, [searchQuery, isCalcQuery]);

  const displayItems = useMemo(() => {
    const items: DisplayItem[] = [];
    if (showCalc && calcResult) items.push({type:"calc", item:{label:calcResult}});
    searchedApps.forEach(a => items.push({type:"app", item:a}));
    // 文件夹仅在搜索模式或面板搜索时加入显示列表（面板无搜索时由底部区域单独渲染）
    if (searchQuery.trim()) {
      searchedFolders.forEach(f => items.push({type:"folder", item:f}));
      fileResults.forEach(f => items.push({type:"file", item:f}));
    }
    return items;
  }, [searchedApps, searchedFolders, fileResults, showCalc, calcResult, searchQuery]);

  useEffect(() => {
    if (displayItems.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= displayItems.length) {
      setSelectedIndex(displayItems.length - 1);
    }
  }, [displayItems.length, selectedIndex]);

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
      invoke("record_app_launch", {id: app.id}).catch(e => console.warn("record launch:", e));
      // 记录搜索历史（仅在搜索模式下）
      if (searchQuery.trim() && view === "search") {
        invoke("record_search", { query: searchQuery.trim() }).then(async () => {
          try { const h = await invoke<string[]>("get_search_history"); if (h) setSearchHistory(h); } catch { /* ignore */ }
        }).catch(e => console.warn("record_search:", e));
      }
      await invoke("launch_app", { path: app.path });
      await getCurrentWindow().hide();
    } catch (e) { console.warn("launchApp error:", app.path, e); showToast("启动失败: " + e, "err"); }
  };
  const openFolder = async (path: string) => {
    try {
      if (searchQuery.trim() && view === "search") {
        invoke("record_search", { query: searchQuery.trim() }).then(async () => {
          try { const h = await invoke<string[]>("get_search_history"); if (h) setSearchHistory(h); } catch { /* ignore */ }
        }).catch(() => {});
      }
      await invoke("launch_app", { path });
    } catch (e) { console.warn("openFolder:", e); showToast("打开文件夹失败: " + e, "err"); }
  };
  const openFile = async (path: string) => {
    try {
      if (searchQuery.trim() && view === "search") {
        invoke("record_search", { query: searchQuery.trim() }).then(async () => {
          try { const h = await invoke<string[]>("get_search_history"); if (h) setSearchHistory(h); } catch { /* ignore */ }
        }).catch(() => {});
      }
      await invoke("launch_app", { path });
    } catch (e) { console.warn("openFile:", e); showToast("打开文件失败: " + e, "err"); }
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
      invoke("update_app_category", { id: dragAppId, category: cat })
        .then(async () => {
          await loadApps();
      await loadCategories();
      await loadFolderCategories();
        })
        .catch(e => console.warn("update category:", e));
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
  const ICON_FAILED = "__failed__"; // 图标提取失败标记，避免反复重试
  const loadIcon = async (appId: number) => {
    if (iconCache[appId]) return; // 已缓存（包括失败标记）则跳过
    try {
      const dataUrl = await invoke<string>("get_app_icon", { appId });
      // 缓存结果：成功=dataUrl，失败=标记值，避免反复重试拖慢其他图标
      setIconCache(prev => ({ ...prev, [appId]: dataUrl || ICON_FAILED }));
    } catch (e) {
      console.warn("loadIcon:", appId, e);
      setIconCache(prev => ({ ...prev, [appId]: ICON_FAILED }));
    }
  };

  // 图标加载：监听当前可见的应用列表（搜索结果 + 面板分类）
  useEffect(() => {
    // 合并搜索结果和面板分类中的应用，确保所有可见应用都加载图标
    const visibleApps = view === "search" && searchQuery.trim()
      ? searchedApps
      : filteredByCategory;
    const toLoad = visibleApps.filter(a => !iconCache[a.id]);
    if (toLoad.length === 0) return;
    let cancelled = false;
    (async () => {
      // 串行加载，不设上限——所有可见应用都需要图标
      for (const app of toLoad) {
        if (cancelled) break;
        await loadIcon(app.id);
      }
    })();
    return () => { cancelled = true; };
  }, [searchedApps, filteredByCategory, view, searchQuery]);

  const removeApp = async (id: number) => { try { await invoke("remove_app", {id}); await loadApps(); } catch (e) { console.warn("remove_app:", e); } setCm(null); };
  const togglePin = async (id: number) => { try { await invoke("toggle_pin_app", {id}); await loadApps(); } catch (e) { console.warn("toggle_pin_app:", e); } setCm(null); };
  const updateCategory = async (id: number, category: string) => {
    try {
      await invoke("update_app_category", {id, category});
      await loadApps();
      await loadCategories();
    } catch (e) {
      console.warn("update_app_category:", e);
      showToast(String(e), "err");
    }
    setCm(null);
  };

  const addCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) {
      showToast("分类名称不能为空", "err");
      return;
    }
    // 前端重复校验：大小写不敏感匹配，避免不友好的后端错误消息
    if (categoryNames.some(c => c.toLowerCase() === name.toLowerCase())) {
      showToast("分类已存在", "err");
      return;
    }
    try {
      const created = await invoke<string>("add_category", { name });
      await loadCategories();
      setActiveCategory(created);
      setNewCategoryName("");
      setShowCategoryInput(false);
      showToast(`已创建分类：${created}`, "ok");
    } catch (e) {
      console.warn("add_category:", e);
      showToast(String(e), "err");
    }
  };

  const addFolder = async () => {
    if (!folderName || !folderPath) return;
    try {
      await invoke("add_folder", { name: folderName, path: folderPath, category: newFolderCategory || undefined });
      await loadFolders();
      await loadFolderCategories();
      setShowFolderInput(false);
      setFolderName("");
      setFolderPath("");
    } catch (e) {
      console.warn("add_folder:", e);
      showToast(String(e), "err");
    }
  };
  const pickFolderPath = async () => {
    try {
      const selected = await dialogOpen({ directory: true, title: "选择文件夹" });
      if (selected && typeof selected === "string") {
        setFolderPath(selected);
        // 自动用文件夹名作为名称（如果名称为空）
        if (!folderName) {
          const folderNameFromPath = selected.split(/[\\/]/).filter(Boolean).pop() || "";
          setFolderName(folderNameFromPath);
        }
      }
    } catch (e) {
      console.warn("pickFolderPath:", e);
    }
  };
  const removeFolder = async (id: number) => { try { await invoke("remove_folder", {id}); await loadFolders(); } catch (e) { console.warn("remove_folder:", e); } };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files) as DroppedFile[]) {
      if (file.name.endsWith(".exe") || file.name.endsWith(".lnk")) {
        const name = file.name.replace(/\.(exe|lnk)$/i,"");
        const path = file.path || file.name;
        try { await invoke("add_app", {name, path}); } catch (e) { console.warn("add_app:", e); }
      }
    }
    await loadApps();
  };

  // 分类对话框
  const [catDialog, setCatDialog] = useState<AppItem|null>(null);
  const [catInput, setCatInput] = useState("");

  return (
    <div className="h-screen w-screen flex flex-col bg-background/70 backdrop-blur-xl rounded-2xl overflow-hidden border border-border shadow-2xl" onContextMenu={e=>e.preventDefault()} onDrop={handleDrop} onDragOver={e=>e.preventDefault()} onClick={() => { setCm(null); setFolderCm(null); }}>
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
            <button onClick={() => setView("folders")} className={`px-2.5 py-1 text-xs rounded-md transition-colors ${view==="folders" ? "bg-background shadow-sm" : "hover:text-foreground text-muted-foreground"}`}>
              <Folder className="w-3.5 h-3.5 inline mr-1" />文件夹
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
                      {iconCache[app.id] && iconCache[app.id] !== "__failed__"
                        ? <img src={iconCache[app.id]} alt="" className="w-full h-full object-contain app-icon" />
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
            <button onClick={() => setActiveCategory("全部")}
              className={`whitespace-nowrap px-3 py-1.5 text-xs rounded-full transition-all ${activeCategory === "全部" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
              全部
            </button>
            {categories.filter(c => c !== "全部").map(cat => (
              <div key={cat} className="relative"
                onDragOver={e => onDragOverTab(e, cat)}
                onDragLeave={onDragLeaveTab}
                onDrop={e => onDropOnTab(e, cat)}>
                <button onClick={() => setActiveCategory(cat)}
                  className={`whitespace-nowrap px-3 py-1.5 text-xs rounded-full transition-all ${activeCategory === cat ? "bg-primary text-primary-foreground" : dragOverCat === cat && dragAppId ? "ring-2 ring-primary bg-secondary" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {cat}
                </button>
              </div>
            ))}
            <button
              onClick={() => setShowCategoryInput(v => !v)}
              aria-label="添加新分类"
              className="whitespace-nowrap px-3 py-1.5 text-xs rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              + 分类
            </button>
          </div>
          {showCategoryInput && (
            <div className="flex gap-1.5 mt-2">
              <input
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") addCategory();
                  if (e.key === "Escape") { setShowCategoryInput(false); setNewCategoryName(""); }
                }}
                placeholder="新分类名称"
                className="flex-1 h-8 px-2 rounded-lg bg-secondary text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
              <button onClick={addCategory} className="h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs">创建</button>
              <button onClick={() => { setShowCategoryInput(false); setNewCategoryName(""); }} className="h-8 px-3 rounded-lg bg-secondary text-xs text-muted-foreground">取消</button>
            </div>
                )}
                {/* 文件夹右键菜单 */}
                {folderCm && (
                  <div className="fixed z-50 w-44 rounded-lg border border-border bg-popover p-1 shadow-xl" style={{ left: folderCm.x, top: folderCm.y }}
                    onClick={e => e.stopPropagation()}>
                    <button onClick={async () => {
                      try { await invoke("reveal_in_explorer", { path: folderCm.folder.path }); } catch (e) { console.warn("reveal:", e); }
                      setFolderCm(null);
                    }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent">
                      <ExternalLink className="w-4 h-4" />打开
                    </button>
                    <button onClick={async () => {
                      try { await invoke("reveal_in_explorer", { path: folderCm.folder.path }); } catch (e) { console.warn("reveal:", e); }
                      setFolderCm(null);
                    }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent">
                      <Folder className="w-4 h-4" />打开所在文件夹
                    </button>
                    <div className="h-px bg-border my-1" />
                    <div className="px-2 py-1 text-xs text-muted-foreground">修改分类</div>
                    <div className="max-h-32 overflow-y-auto">
                      {folderCategories.map(cat => (
                        <button key={cat} onClick={async () => {
                          try {
                            await invoke("update_folder_category", { id: folderCm.folder.id, category: cat });
                            await loadFolders();
                            showToast(`已移至分类：${cat}`, "ok");
                          } catch (e) {
                            console.warn("update_folder_category:", e);
                            showToast(String(e), "err");
                          }
                          setFolderCm(null);
                        }} className={`flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent ${cat === folderCm.folder.category ? "text-primary font-medium" : ""}`}>
                          {cat === folderCm.folder.category && <span className="w-2 h-2 rounded-full bg-primary inline-block" />}
                          {cat}
                        </button>
                      ))}
                    </div>
                    <div className="h-px bg-border my-1" />
                    <button onClick={async () => {
                      await removeFolder(folderCm.folder.id);
                      setFolderCm(null);
                    }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-destructive/10 text-destructive">
                      <Trash2 className="w-4 h-4" />删除
                    </button>
                  </div>
                )}
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
        ) : view === "folders" && !searchQuery.trim() ? (
          (() => {
            const filteredFolders = activeFolderCategory === "全部"
              ? folders
              : folders.filter(f => f.category === activeFolderCategory);
            return (
              <div className="flex flex-col gap-3">
                {/* 文件夹分类标签栏 */}
                <div className="flex items-center justify-between">
                  <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                    <button onClick={() => setActiveFolderCategory("全部")}
                      className={`whitespace-nowrap px-3 py-1.5 text-xs rounded-full transition-all ${activeFolderCategory === "全部" ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                      全部
                    </button>
                    {folderCategories.map(cat => (
                      <button key={cat} onClick={() => setActiveFolderCategory(cat)}
                        className={`whitespace-nowrap px-3 py-1.5 text-xs rounded-full transition-all ${activeFolderCategory === cat ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                        {cat}
                      </button>
                    ))}
                    <button
                      onClick={async () => {
                        const name = prompt("输入文件夹分类名称：");
                        if (name && name.trim()) {
                          try {
                            await invoke("add_folder_category", { name: name.trim() });
                            await loadFolderCategories();
                            showToast(`已创建分类：${name.trim()}`, "ok");
                          } catch (e) {
                            console.warn("add_folder_category:", e);
                            showToast(String(e), "err");
                          }
                        }
                      }}
                      className="whitespace-nowrap px-3 py-1.5 text-xs rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    >
                      + 分类
                    </button>
                  </div>
                  <button onClick={() => setShowFolderInput(!showFolderInput)} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0" title="添加文件夹">
                    <FolderPlus className="w-4 h-4" />
                  </button>
                </div>
                {/* 添加文件夹表单 */}
                {showFolderInput && (
                  <div className="flex flex-col gap-1.5 p-3 rounded-xl bg-secondary border border-border">
                    <input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="名称" className="h-8 px-2 rounded-lg bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring" />
                    <div className="flex gap-1">
                      <button onClick={pickFolderPath} className="h-8 px-3 rounded-lg bg-background text-xs text-muted-foreground hover:text-foreground border border-border shrink-0">
                        <Folder className="w-3.5 h-3.5 inline mr-1" />选择文件夹
                      </button>
                      {folderPath && (
                        <span className="h-8 px-2 flex items-center text-xs text-muted-foreground truncate bg-background rounded-lg border border-border flex-1 min-w-0">{folderPath}</span>
                      )}
                    </div>
                    {/* 分类选择 */}
                    <select
                      value={newFolderCategory}
                      onChange={e => setNewFolderCategory(e.target.value)}
                      className="h-8 px-2 rounded-lg bg-background text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {folderCategories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <div className="flex gap-1">
                      <button onClick={addFolder} disabled={!folderName || !folderPath} className="flex-1 h-8 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50">添加</button>
                      <button onClick={() => { setShowFolderInput(false); setFolderName(""); setFolderPath(""); }} className="h-8 px-3 rounded-lg bg-background text-xs text-muted-foreground border border-border">取消</button>
                    </div>
                  </div>
                )}
                {/* 文件夹 grid */}
                {filteredFolders.length > 0 ? (
                  <div className="grid grid-cols-5 gap-2">
                    {filteredFolders.map(f => (
                      <button key={f.id} onClick={() => openFolder(f.path)} onContextMenu={e => { e.preventDefault(); setFolderCm({ x: e.clientX, y: e.clientY, folder: f }); }}
                        className="relative flex flex-col items-center gap-1.5 p-3 rounded-xl bg-secondary hover:bg-accent transition-colors group">
                        <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                          <Folder className="w-7 h-7 text-amber-500" />
                        </div>
                        <span className="text-xs text-center text-foreground truncate w-full">{f.name}</span>
                        <span className="text-[9px] text-muted-foreground/50">{f.category}</span>
                        <Trash2 onClick={e => { e.stopPropagation(); removeFolder(f.id); }} className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity absolute top-1 right-1" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Folder className="w-12 h-12 mb-3 opacity-20" />
                    <p className="text-sm">{activeFolderCategory === "全部" ? "还没有常用文件夹" : "该分类暂无文件夹"}</p>
                    <p className="text-xs mt-1">点击右上角 + 添加</p>
                  </div>
                )}
              </div>
            );
          })()
        ) : displayItems.length === 0 && !searchQuery.trim() && view === "panel" ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <LayoutGrid className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">该分类暂无应用</p>
          </div>
        ) : displayItems.length === 0 && !searchQuery.trim() && view === "search" ? (
          (() => {
            const topApps = [...apps].sort((a,b) => b.use_count - a.use_count).slice(0, 8).filter(a => a.use_count > 0);
            return (
              <div className="flex flex-col gap-4 py-2">
                {/* 搜索历史 */}
                {searchHistory.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />搜索历史
                      </span>
                      <button onClick={async () => {
                        try { await invoke("clear_search_history"); setSearchHistory([]); } catch (e) { console.warn("clearSearchHistory:", e); }
                      }} className="text-xs text-muted-foreground/50 hover:text-destructive transition-colors">清空</button>
                    </div>
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                      {searchHistory.slice(0, 10).map(q => (
                        <button key={q} onClick={() => { setSearchQuery(q); inputRef.current?.focus(); }}
                          className="px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-accent text-xs whitespace-nowrap transition-colors">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 常用应用 */}
                {topApps.length > 0 && (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground mb-1.5 block">常用应用</span>
                    <div className="grid grid-cols-5 gap-2">
                      {topApps.map(app => (
                        <button key={app.id} onClick={() => launchApp(app)}
                          className="flex flex-col items-center gap-1.5 p-2.5 rounded-xl bg-secondary hover:bg-accent transition-colors">
                          <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted flex items-center justify-center text-sm font-bold">
                            {iconCache[app.id] && iconCache[app.id] !== "__failed__"
                              ? <img src={iconCache[app.id]} alt="" className="w-full h-full object-contain app-icon" />
                              : <span>{app.name.charAt(0)}</span>}
                          </div>
                          <span className="text-xs text-center text-muted-foreground truncate w-full">{app.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 两者都无时显示空提示 */}
                {searchHistory.length === 0 && topApps.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Search className="w-12 h-12 mb-3 opacity-20" />
                    <p className="text-sm">输入关键词搜索应用</p>
                  </div>
                )}
              </div>
            );
          })()
        ) : displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Search className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm">{searchQuery ? "未找到匹配项" : "还没有应用"}</p>
            <p className="text-xs mt-1">拖拽 exe 到这里添加</p>
          </div>
        ) : (
          <>
            {/* 应用区域 */}
            {(() => {
              const appItems = displayItems.filter(i => i.type === "app" || i.type === "calc");
              const folderItems = displayItems.filter(i => i.type === "folder" || i.type === "file");
              const appStartIdx = 0;
              return (
                <>
                  {appItems.length > 0 && (
                    <div className="grid grid-cols-5 gap-2" style={{ contentVisibility: "auto" }}>
                      {appItems.map((item) => {
                        const idx = displayItems.indexOf(item);
                        if (item.type === "calc") return (
                          <div key="calc" className="col-span-5 flex items-center gap-3 p-3 rounded-xl transition-all" style={{contentVisibility:"visible"}}>
                            <Calculator className="w-5 h-5 text-primary" />
                            <span className="text-lg font-mono font-bold text-foreground">{item.item.label}</span>
                          </div>
                        );
                        const app = item.item as AppItem;
                        return <AppCard key={app.id} app={app}
                          idx={idx} selectedIndex={selectedIndex} dragAppId={dragAppId}
                          searchQuery={searchQuery} iconCache={iconCache}
                          onDragStart={onDragStart} onDragEnd={onDragEnd}
                          onClick={launchApp}
                          onContextMenu={(a2, cx, cy) => setCm({x: cx, y: cy, app: a2})}
                        />;
                      })}
                    </div>
                  )}
                  {/* 文件夹/文件区域 — 分区显示，避免与应用混淆 */}
                  {folderItems.length > 0 && (
                    <div className="mt-3">
                      <span className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        <Folder className="w-3.5 h-3.5 inline mr-1 text-amber-500" />文件夹
                      </span>
                      <div className="grid grid-cols-5 gap-2" style={{ contentVisibility: "auto" }}>
                        {folderItems.map((item) => {
                          const idx = displayItems.indexOf(item);
                          if (item.type === "file") {
                            const f = item.item as {name:string;path:string;is_dir:boolean};
                            return (
                              <button key={`file-${f.path}`} onClick={() => openFile(f.path)}
                                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"}`}
                                style={{contentVisibility:"visible"}}>
                                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                                  <Folder className="w-7 h-7 text-blue-500" />
                                </div>
                                <span className="text-xs text-center text-muted-foreground truncate w-full">{f.name}</span>
                                <span className="text-[9px] text-muted-foreground/50 truncate w-full">{f.is_dir ? "文件夹" : "文件"}</span>
                              </button>
                            );
                          }
                          const f = item.item as FolderItem;
                          return (
                            <button key={`f-${f.id}`} onClick={() => openFolder(f.path)}
                              className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-2 ring-ring scale-105" : "hover:bg-accent/50"}`}
                              onContextMenu={e => { e.preventDefault(); }}
                              style={{contentVisibility:"visible"}}>
                              <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                                <Folder className="w-7 h-7 text-amber-500" />
                              </div>
                              <span className="text-xs text-center text-muted-foreground truncate w-full">{f.name}</span>
                              <span className="text-[9px] text-muted-foreground/50 truncate w-full">文件夹</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {cm && (
        <div className="fixed z-50 w-44 rounded-lg border border-border bg-popover p-1 shadow-xl" style={{left: cm.x, top: cm.y}}>
          <button onClick={() => { launchApp(cm.app); setCm(null); }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><ExternalLink className="w-4 h-4" />启动</button>
          <button onClick={() => togglePin(cm.app.id)} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><Pin className="w-4 h-4" />{cm.app.is_pinned ? "取消固定" : "固定到顶部"}</button>
          <button onClick={() => { setCatDialog(cm.app); setCatInput(cm.app.category); setCm(null); }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><FileType className="w-4 h-4" />修改分类</button>
          <button onClick={async () => { try { await invoke("reveal_in_explorer", { path: cm.app.path }); } catch (e) { console.warn("reveal:", e); } setCm(null); }} className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-md hover:bg-accent"><Folder className="w-4 h-4" />打开所在文件夹</button>
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
