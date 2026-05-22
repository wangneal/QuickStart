import { useEffect, useRef, useState, useCallback, useMemo, memo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "./lib/utils";
import { useStore, type AppItem } from "./store";
import AIChat from "./AIChat";
import SettingsPanel from "./Settings";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragStartEvent, DragEndEvent, DragOverlay, useDraggable, useDroppable, UniqueIdentifier,
} from "@dnd-kit/core";
import {
  arrayMove, SortableContext, useSortable, sortableKeyboardCoordinates, horizontalListSortingStrategy, rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Search, Mic, Settings, X, Minus, Maximize2, Folder, Trash2, Pin, ScanLine,
  ExternalLink, Calculator, LayoutGrid, List, Plus, FolderPlus, FileType, Bot, Clock,
  Sun, Moon, Loader2,
} from "lucide-react";

// ---------- 工具函数 ----------
const MENU_WIDTH = 176; // w-44 = 11rem = 176px
const clampMenuPos = (x: number, y: number) => ({
  left: Math.min(x, window.innerWidth - MENU_WIDTH - 8),
  top: Math.min(y, window.innerHeight - 300),
});

// 分词：按空格、连字符、点号、驼峰分割
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

// 可排序分类标签按钮（同时也是 drop 目标）
function SortableCatButton({ id, cat, isActive, isDragging, onClick }: { id: string; cat: string; isActive: boolean; isDragging: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `cat-drop-${cat}` });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const mergedRef = (node: HTMLButtonElement | null) => { setNodeRef(node); setDropRef(node); };
  return (
    <button ref={mergedRef} style={style} {...attributes} {...listeners} onClick={onClick}
      className={`whitespace-nowrap px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors duration-200 cursor-grab active:cursor-grabbing ${isActive ? "bg-primary text-primary-foreground shadow-md font-semibold animate-subtle-pulse" :
        isDragging ? "opacity-50 scale-95 bg-secondary" :
          isOver ? "ring-2 ring-primary bg-secondary scale-105" :
            "bg-secondary/50 text-foreground/80 hover:text-foreground hover:bg-accent/70"
        }`}>
      {cat}
    </button>
  );
};

// 可排序文件夹卡片（可拖拽排序 + 拖到分类标签更改分类）
function SortableFolderCard({ folder, isSelected, isDragging, onClick, onContextMenu, onRemove }: { folder: { id: number; name: string; path: string; category: string }; isSelected: boolean; isDragging: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: `folder-${folder.id}`, data: { type: "folder", folder } });
  const base = CSS.Transform.toString(transform) || "";
  const style: React.CSSProperties = { transform: isDragging ? `${base} scale(0.92)` : (base || undefined), transition, opacity: isDragging ? 0.5 : undefined, zIndex: isDragging ? 50 : undefined };
  return (
    <button ref={setNodeRef} style={style} {...attributes} {...listeners}
      onClick={onClick} onContextMenu={onContextMenu}
      className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl transition-colors duration-200 group cursor-grab active:cursor-grabbing ${isSelected ? "bg-accent ring-1 ring-ring/40 shadow-sm" :
        isDragging ? "ring-2 ring-primary/30 bg-secondary" :
          "bg-secondary/70 hover:bg-accent/60 hover:-translate-y-0.5 hover:shadow-sm"
        }`}>
      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
        <Folder className="w-7 h-7 text-primary" />
      </div>
      <span className="text-xs text-center text-foreground truncate w-full">{folder.name}</span>
      <span className="text-[9px] text-muted-foreground/80">{folder.category}</span>
      <Trash2 onClick={e => { e.stopPropagation(); onRemove(); }} className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity absolute top-1 right-1" />
    </button>
  );
}

// 可排序常用应用横向小卡片（面板模式）
function SortableTopAppChip({ app, iconCache, isDragging, onClick }: { app: AppItem; iconCache: Record<number, string>; isDragging: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: `topapp-${app.id}` });
  const base = CSS.Transform.toString(transform) || "";
  const style: React.CSSProperties = { transform: isDragging ? `${base} scale(0.92)` : (base || undefined), transition, opacity: isDragging ? 0.5 : undefined, zIndex: isDragging ? 50 : undefined };
  return (
    <button ref={setNodeRef} style={style} {...attributes} {...listeners} onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl border shrink-0 transition-colors duration-200 cursor-grab active:cursor-grabbing ${isDragging ? "bg-secondary border-primary/40 ring-2 ring-primary/30" :
        "bg-secondary/50 border-border/40 hover:bg-accent/70 hover:border-primary/30 hover:-translate-y-0.5 hover:shadow-sm"
        }`}>
      <div className="w-6 h-6 rounded-lg overflow-hidden bg-muted flex items-center justify-center text-[10px] font-bold shrink-0 ring-1 ring-border/20">
        {iconCache[app.id] && iconCache[app.id] !== "__failed__"
          ? <img src={iconCache[app.id]} alt="" className="w-full h-full object-contain app-icon" />
          : <span>{app.name.charAt(0)}</span>}
      </div>
      <span className="text-xs whitespace-nowrap font-medium" title={app.name.length > 12 ? app.name : undefined}>{smartTruncate(app.name, 10)}</span>
    </button>
  );
}

// 可排序常用应用网格小卡片（搜索模式）
function SortableTopAppGridCard({ app, iconCache, isDragging, onClick }: { app: AppItem; iconCache: Record<number, string>; isDragging: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: `topapp-grid-${app.id}` });
  const base = CSS.Transform.toString(transform) || "";
  const style: React.CSSProperties = { transform: isDragging ? `${base} scale(0.92)` : (base || undefined), transition, opacity: isDragging ? 0.5 : undefined, zIndex: isDragging ? 50 : undefined };
  return (
    <button ref={setNodeRef} style={style} {...attributes} {...listeners} onClick={onClick}
      className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-colors duration-200 cursor-grab active:cursor-grabbing ${isDragging ? "ring-2 ring-primary/30 bg-secondary" :
        "bg-secondary/70 hover:bg-accent/80 hover:-translate-y-0.5 hover:shadow-sm"
        }`}>
      <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted flex items-center justify-center text-sm font-bold ring-1 ring-border/10">
        {iconCache[app.id] && iconCache[app.id] !== "__failed__"
          ? <img src={iconCache[app.id]} alt="" className="w-full h-full object-contain app-icon" />
          : <span>{app.name.charAt(0)}</span>}
      </div>
      <span className="text-xs text-center text-foreground truncate w-full font-medium" title={app.name.length > 12 ? app.name : undefined}>{smartTruncate(app.name, 10)}</span>
    </button>
  );
}

function AppCard({ app, idx, selectedIndex, searchQuery, iconCache, isDragging, onClick, onContextMenu }: {
  app: AppItem; idx: number; selectedIndex: number;
  searchQuery: string; iconCache: Record<number, string>;
  isDragging: boolean;
  onClick: (a: AppItem) => void;
  onContextMenu: (a: AppItem, x: number, y: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: app.id });
  const base = CSS.Transform.toString(transform) || "";
  const style: React.CSSProperties = { transform: isDragging ? `${base} scale(0.92)` : (base || undefined), transition, opacity: isDragging ? 0.5 : undefined, zIndex: isDragging ? 50 : undefined };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}
      onClick={() => onClick(app)}
      onContextMenu={e => { e.preventDefault(); onContextMenu(app, e.clientX, e.clientY); }}
      className={`relative flex flex-col items-center gap-2 p-3 rounded-xl transition-colors duration-200 ease-out group cursor-grab active:cursor-grabbing ${idx === selectedIndex ? "bg-accent ring-2 ring-primary/50 shadow-md" :
        isDragging ? "ring-2 ring-primary/30 bg-secondary" :
          "hover:bg-accent/60 hover:-translate-y-1 hover:shadow-md"
        }`}>
      <div className="w-12 h-12 rounded-xl overflow-hidden bg-secondary flex items-center justify-center">
        {iconCache[app.id] && iconCache[app.id] !== "__failed__"
          ? <img src={iconCache[app.id]} alt={app.name} className="w-full h-full object-contain app-icon" />
          : <span className="text-lg font-bold text-foreground">{app.name.charAt(0)}</span>}
      </div>
      <span className="text-xs text-center text-foreground truncate w-full leading-tight" title={app.name.length > 12 ? app.name : undefined}>{highlight(smartTruncate(app.name), searchQuery)}</span>
      <span className="text-[9px] text-muted-foreground/80 truncate w-full">{app.category}</span>
      {app.is_pinned && <Pin className="absolute top-1 right-1 w-3 h-3 text-primary" />}
    </div>
  );
}

/** 智能缩写应用名：保留品牌名 + 缩写后续词，如 "Microsoft Visual Studio Code" -> "VS Code" */
function smartTruncate(name: string, maxLen: number = 12): string {
  if (name.length <= maxLen) return name;
  // 常见前缀缩写映射
  const prefixMap: [RegExp, string][] = [
    [/^Microsoft\s+/i, "MS "],
    [/^Google\s+/i, ""],
    [/^Adobe\s+/i, ""],
    [/^Apple\s+/i, ""],
    [/^Mozilla\s+Firefox/i, "Firefox"],
    [/^Mozilla\s+/i, ""],
    [/^WPS\s+Office/i, "WPS Office"],
    [/^JetBrains\s+/i, "JB "],
    [/^Visual\s+Studio\s+Code/i, "VS Code"],
    [/^Visual\s+Studio\s(?:(?!Code).)+$/i, "VS"],
    [/(?:\s+\d{4,})+$/, ""], // 移除尾部年份 " 2024 2025"
    [/\s*\(\d+\)\s*$/, ""], // 移除尾部括号数字 "(1)"
    [/(?:\s*[-–—](?:\s*\d+)?(?:\s*bits?)?(?:\s*\(\d+\))?)?\s*\.?exe$/i, ""], // 移除尾部.exe及版本信息
  ];
  let result = name;
  for (const [re, rep] of prefixMap) {
    result = result.replace(re, rep);
  }
  // 清理多余空格
  result = result.replace(/\s+/g, " ").trim();
  if (result.length <= maxLen) return result;
  // 最终截断：保留前 maxLen-1 个字符 + "…"
  return result.slice(0, maxLen - 1) + "…";
}

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
  constructor(private onResult: (t: string) => void, private onEnd: () => void) { }
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.onEnd(); return; }
    this.r = new SR(); this.r.lang = "zh-CN"; this.r.continuous = false; this.r.interimResults = false; this.r.maxAlternatives = 1;
    this.r.onresult = (e) => this.onResult(e.results[0][0].transcript);
    this.r.onend = () => this.onEnd(); this.r.onerror = () => this.onEnd();
    try { this.r.start(); } catch { this.onEnd(); }
  }
  stop() { if (this.r) { this.r.onend = null; this.r.onerror = null; try { this.r.stop(); } catch (e) { console.warn("speech stop:", e); } this.r = null; } this.onEnd(); }
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
  const contentRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"search" | "panel" | "folders">("search");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [cm, setCm] = useState<{ x: number; y: number; app: AppItem } | null>(null);
  const [calcResult, setCalcResult] = useState<string | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const speechRef = useRef<SpeechManager | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState("全部");
  const [folderCategories, setFolderCategories] = useState<string[]>([]);
  const [activeFolderCategory, setActiveFolderCategory] = useState("全部");
  const [showSettings, setShowSettings] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [newFolderCategory, setNewFolderCategory] = useState("未分类");
  const [showFolderCategoryInput, setShowFolderCategoryInput] = useState(false);
  const [newFolderCategoryName, setNewFolderCategoryName] = useState("");
  const [folderCm, setFolderCm] = useState<{ x: number; y: number; folder: FolderItem } | null>(null);
  const [folderSelectedIndex, setFolderSelectedIndex] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [iconCache, setIconCache] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // 主题切换
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggleTheme = useCallback(async () => {
    const next = !isDark;
    setIsDark(next);
    if (next) document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
    try { await invoke("set_setting", { key: "theme", value: next ? "dark" : "light" }); } catch (e) { console.warn("set theme:", e); }
  }, [isDark]);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, type });
    toastTimerRef.current = window.setTimeout(() => { setToast(null); toastTimerRef.current = null; }, 3000);
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
      setScanning(false); // 失败时立即重置（scan-complete 事件不会触发）
    }
    // 成功时由 scan-complete 事件处理器负责 setScanning(false)
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
      await loadFolderCategories();
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
      await loadFolderCategories();
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
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await invoke<FileResult[]>("search_files", { query: q });
        if (!cancelled) setFileResults(r);
      } catch (e) { console.warn("search_files:", e); if (!cancelled) setFileResults([]); }
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery]);
  useEffect(() => { const h = () => { setCm(null); setFolderCm(null); }; window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);

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
    if (showCalc && calcResult) items.push({ type: "calc", item: { label: calcResult } });
    searchedApps.forEach(a => items.push({ type: "app", item: a }));
    // 文件夹仅在搜索模式或面板搜索时加入显示列表（面板无搜索时由底部区域单独渲染）
    if (searchQuery.trim()) {
      searchedFolders.forEach(f => items.push({ type: "folder", item: f }));
      fileResults.forEach(f => items.push({ type: "file", item: f }));
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

  // 文件夹分类切换时重置选中索引
  const filteredFolders = useMemo(() => {
    return activeFolderCategory === "全部" ? folders : folders.filter(f => f.category === activeFolderCategory);
  }, [folders, activeFolderCategory]);
  useEffect(() => {
    if (filteredFolders.length === 0) setFolderSelectedIndex(0);
    else if (folderSelectedIndex >= filteredFolders.length) setFolderSelectedIndex(filteredFolders.length - 1);
  }, [filteredFolders.length, folderSelectedIndex]);

  // 键盘导航时自动滚动选中项到可视区
  useEffect(() => {
    if (!contentRef.current) return;
    const idx = view === "folders" ? folderSelectedIndex : selectedIndex;
    const grid = contentRef.current.querySelector(".grid-cols-5");
    if (!grid) return;
    const items = grid.children;
    if (items[idx]) {
      (items[idx] as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex, folderSelectedIndex, view]);

  const GRID_COLS = 5;

  // 按键
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 优先关闭右键菜单和对话框
    if (cm) { setCm(null); e.preventDefault(); return; }
    if (folderCm) { setFolderCm(null); e.preventDefault(); return; }
    if (catDialog) { setCatDialog(null); e.preventDefault(); return; }
    // 文件夹视图的键盘导航
    if (view === "folders" && !searchQuery.trim()) {
      if (e.key === "Escape") { hideWindow(); return; }
      if (filteredFolders.length === 0) return;
      if (e.key === "ArrowRight") { e.preventDefault(); setFolderSelectedIndex(i => Math.min(i + 1, filteredFolders.length - 1)); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); setFolderSelectedIndex(i => Math.max(i - 1, 0)); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setFolderSelectedIndex(i => Math.min(i + GRID_COLS, filteredFolders.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setFolderSelectedIndex(i => Math.max(i - GRID_COLS, 0)); }
      else if (e.key === "Enter") {
        if (filteredFolders[folderSelectedIndex]) openFolder(filteredFolders[folderSelectedIndex].path);
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex(i => Math.min(i + GRID_COLS, displayItems.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex(i => Math.max(i - GRID_COLS, 0)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, displayItems.length - 1)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
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
      invoke("record_app_launch", { id: app.id }).catch(e => console.warn("record launch:", e));
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
        }).catch(() => { });
      }
      await invoke("launch_app", { path });
    } catch (e) { console.warn("openFolder:", e); showToast("打开文件夹失败: " + e, "err"); }
  };
  const openFile = async (path: string) => {
    try {
      if (searchQuery.trim() && view === "search") {
        invoke("record_search", { query: searchQuery.trim() }).then(async () => {
          try { const h = await invoke<string[]>("get_search_history"); if (h) setSearchHistory(h); } catch { /* ignore */ }
        }).catch(() => { });
      }
      await invoke("launch_app", { path });
    } catch (e) { console.warn("openFile:", e); showToast("打开文件失败: " + e, "err"); }
  };
  // ---------- dnd-kit 拖拽 ----------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // 分类排序 drag
  const [activeCatId, setActiveCatId] = useState<UniqueIdentifier | null>(null);
  const handleCatDragStart = (e: DragStartEvent) => setActiveCatId(e.active.id);
  const handleCatDragEnd = async (e: DragEndEvent) => {
    setActiveCatId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const cats = categories.filter(c => c !== "全部");
    const oldIdx = cats.indexOf(String(active.id));
    const newIdx = cats.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(cats, oldIdx, newIdx);
    try { await invoke("reorder_categories", { categoryNames: reordered }); await loadCategories(); }
    catch (e) { console.warn("reorder_categories:", e); }
  };

  // 文件夹分类排序 + 拖拽文件夹到分类标签
  const [activeFolderCatId, setActiveFolderCatId] = useState<UniqueIdentifier | null>(null);
  const [draggingFolderId, setDraggingFolderId] = useState<number | null>(null);
  const handleFolderCatDragStart = (e: DragStartEvent) => {
    setActiveFolderCatId(e.active.id);
    // 检测是否是文件夹卡片拖拽
    const fd = e.active.data.current as { type?: string; folder?: { id: number } } | undefined;
    if (fd?.type === "folder" && fd.folder) setDraggingFolderId(fd.folder.id);
  };
  const handleFolderCatDragEnd = async (e: DragEndEvent) => {
    setActiveFolderCatId(null);
    const { active, over } = e;
    if (!over) { setDraggingFolderId(null); return; }

    // 文件夹拖到分类标签 -> 更改分类
    if (draggingFolderId !== null) {
      const overId = String(over.id);
      // 拖到分类标签上 (droppable id or sortable id)
      let targetCat: string | null = null;
      if (overId.startsWith("cat-drop-")) {
        targetCat = overId.replace("cat-drop-", "");
      } else if (folderCategories.includes(overId)) {
        targetCat = overId;
      }
      if (targetCat) {
        try {
          await invoke("update_folder_category", { id: draggingFolderId, category: targetCat });
          await loadFolders();
          showToast(`已移至分类：${targetCat}`);
        } catch (e) { console.warn("update_folder_category:", e); }
        setDraggingFolderId(null);
        return;
      }
      // 拖到另一个文件夹上 -> 排序
      if (overId.startsWith("folder-") && active.id !== over.id) {
        const overFolderId = Number(overId.replace("folder-", ""));
        const folderIds = filteredFolders.map(f => f.id);
        const oldIdx = folderIds.indexOf(draggingFolderId);
        const newIdx = folderIds.indexOf(overFolderId);
        if (oldIdx !== -1 && newIdx !== -1) {
          const reordered = arrayMove(folderIds, oldIdx, newIdx);
          try { await invoke("reorder_folders", { folderIds: reordered }); await loadFolders(); }
          catch (e) { console.warn("reorder_folders:", e); }
        }
      }
      setDraggingFolderId(null);
      return;
    }

    // 分类标签间排序
    if (active.id === over.id) return;
    const oldIdx = folderCategories.indexOf(String(active.id));
    const newIdx = folderCategories.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(folderCategories, oldIdx, newIdx);
    try { await invoke("reorder_folder_categories", { categoryNames: reordered }); await loadFolderCategories(); }
    catch (e) { console.warn("reorder_folder_categories:", e); }
  };

  // 应用排序 drag
  const [activeAppDragId, setActiveAppDragId] = useState<number | null>(null);
  const appItems = useMemo(() => displayItems.filter(i => i.type === "app").map(i => (i as { type: "app"; item: AppItem }).item), [displayItems]);
  const appIds = useMemo(() => appItems.map(a => a.id), [appItems]);
  const handleAppDragEnd = async (e: DragEndEvent) => {
    setActiveAppDragId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = appIds.indexOf(Number(active.id));
    const newIdx = appIds.indexOf(Number(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(appIds, oldIdx, newIdx);
    try { await invoke("reorder_apps", { appIds: reordered }); await loadApps(); }
    catch (e) { console.warn("reorder_apps:", e); }
  };

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
  }, [searchedApps, filteredByCategory, view, searchQuery, iconCache]);

  const removeApp = async (id: number) => { try { await invoke("remove_app", { id }); await loadApps(); } catch (e) { console.warn("remove_app:", e); } setCm(null); };
  const togglePin = async (id: number) => { try { await invoke("toggle_pin_app", { id }); await loadApps(); } catch (e) { console.warn("toggle_pin_app:", e); } setCm(null); };
  const updateCategory = async (id: number, category: string) => {
    try {
      await invoke("update_app_category", { id, category });
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
  const removeFolder = async (id: number) => { try { await invoke("remove_folder", { id }); await loadFolders(); } catch (e) { console.warn("remove_folder:", e); } };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer.files) as DroppedFile[]) {
      if (file.name.endsWith(".exe") || file.name.endsWith(".lnk")) {
        const name = file.name.replace(/\.(exe|lnk)$/i, "");
        const path = file.path || file.name;
        try { await invoke("add_app", { name, path }); } catch (e) { console.warn("add_app:", e); }
      }
    }
    await loadApps();
  };

  // 分类对话框
  const [catDialog, setCatDialog] = useState<AppItem | null>(null);
  const [catInput, setCatInput] = useState("");

  return (
    <div className="h-screen w-screen flex flex-col bg-background/70 backdrop-blur-xl rounded-2xl overflow-hidden border border-border/80 shadow-2xl relative ring-1 ring-primary/5 focus-within:ring-primary/15 transition-all duration-500" onContextMenu={e => e.preventDefault()} onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => { setCm(null); setFolderCm(null); }}>
      {/* 顶部渐变装饰线 */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent z-10" />
      {/* 标题栏 */}
      <div className="titlebar flex items-center justify-between px-5 py-2 select-none">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text">QuickStart</span>
          <div className="flex bg-muted/80 rounded-xl p-0.5 ring-1 ring-border/30">
            <button onClick={() => setView("search")} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${view === "search" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Search className="w-3.5 h-3.5" />搜索
            </button>
            <button onClick={() => setView("panel")} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${view === "panel" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <LayoutGrid className="w-3.5 h-3.5" />应用中心
            </button>
            <button onClick={() => setView("folders")} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${view === "folders" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Folder className="w-3.5 h-3.5" />文件夹
            </button>
          </div>
        </div>
        <div className="titlebar-button flex items-center gap-0.5">
          <button onClick={() => setShowAIChat(!showAIChat)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title="AI 助手">
            <Bot className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border/50 mx-0.5" />
          <button onClick={toggleTheme} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title="切换主题">
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <div className="w-px h-4 bg-border/50 mx-0.5" />
          <button onClick={doScan} disabled={scanning} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 disabled:opacity-50 active:scale-95" title="扫描并分类">
            <ScanLine className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />
          </button>
          <div className="w-px h-4 bg-border/50 mx-0.5" />
          <button onClick={() => setShowSettings(true)} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title="设置">
            <Settings className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-border/50 mx-0.5" />
          <button onClick={minimizeWindow} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title="最小化">
            <Minus className="w-4 h-4" />
          </button>
          <button onClick={toggleMaximize} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title={maximized ? "还原" : "最大化"}>
            <Maximize2 className="w-4 h-4" />
          </button>
          <button onClick={hideWindow} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-all duration-150 active:scale-95" title="隐藏">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="px-5 pb-3">
        <div className="relative group">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/80 group-focus-within:text-primary/70 transition-colors duration-200" />
          <input ref={inputRef} type="text" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setSelectedIndex(0); }} onKeyDown={handleKeyDown}
            placeholder="搜索应用、文件夹或输入算式..." className="w-full h-12 pl-10 pr-20 rounded-xl bg-secondary/60 border border-border/60 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 focus:bg-background/90 transition-all duration-200 text-foreground placeholder:text-muted-foreground text-sm" />
          {/* 加载指示器 */}
          {scanning && (
            <div className="absolute right-12 top-1/2 -translate-y-1/2">
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
            </div>
          )}
          {/* 清空按钮 */}
          {searchQuery.trim() && (
            <button onClick={() => { setSearchQuery(""); setSelectedIndex(0); inputRef.current?.focus(); }}
              className="absolute right-11 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-secondary text-muted-foreground/60 hover:text-foreground transition-all duration-150 active:scale-90"
              title="清空">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={toggleListening} className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all duration-200 ${isListening ? "bg-destructive text-destructive-foreground animate-pulse shadow-lg shadow-destructive/20" : "text-muted-foreground/80 hover:text-foreground hover:bg-accent/80 active:scale-90"}`} title="语音输入">
            <Mic className="w-4 h-4" />
          </button>
        </div>
        {isListening && <div className="mt-1.5 text-xs text-center text-muted-foreground/80 animate-pulse">正在聆听...</div>}
      </div>

      {/* 常用应用（面板模式 + 无搜索时显示） */}
      {view === "panel" && !searchQuery.trim() && (
        (() => {
          const topApps = apps.filter(a => a.use_count > 0).slice(0, 8);
          if (topApps.length === 0) return null;
          return (
            <div className="px-5 pb-3">
              <span className="text-[11px] font-medium text-muted-foreground mb-2 block tracking-wide uppercase">常用应用</span>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => { setActiveAppDragId(Number(String(e.active.id).replace("topapp-", ""))); }} onDragEnd={async e => {
                setActiveAppDragId(null);
                const { active, over } = e;
                if (!over || active.id === over.id) return;
                const ids = topApps.map((a: AppItem) => a.id);
                const aid = Number(String(active.id).replace("topapp-", ""));
                const oid = Number(String(over.id).replace("topapp-", ""));
                const oi = ids.indexOf(aid); const ni = ids.indexOf(oid);
                if (oi === -1 || ni === -1) return;
                const reordered = arrayMove(ids, oi, ni);
                try { await invoke("reorder_apps", { appIds: reordered }); await loadApps(); } catch (err) { console.warn(err); }
              }}>
                <SortableContext items={topApps.map((a: AppItem) => `topapp-${a.id}`)} strategy={horizontalListSortingStrategy}>
                  <div className="flex gap-2 overflow-x-auto scrollbar-none pb-0.5">
                    {topApps.map((app: AppItem) => (
                      <SortableTopAppChip key={app.id} app={app} iconCache={iconCache} isDragging={activeAppDragId === app.id} onClick={() => launchApp(app)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          );
        })()
      )}

      {/* 面板：分类标签（可拖放排序） */}
      {view === "panel" && !searchQuery.trim() && (
        <div className="px-5 pb-2 overflow-x-auto scrollbar-none">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleCatDragStart} onDragEnd={handleCatDragEnd}>
            <SortableContext items={categories.filter(c => c !== "全部")} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-1.5">
                <button onClick={() => setActiveCategory("全部")}
                  className={`whitespace-nowrap px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${activeCategory === "全部" ? "bg-primary text-primary-foreground shadow-md font-semibold animate-subtle-pulse" : "bg-secondary/50 text-foreground/80 hover:text-foreground hover:bg-accent/70"}`}>
                  全部
                </button>
                {categories.filter(c => c !== "全部").map(cat => (
                  <SortableCatButton key={cat} id={cat} cat={cat} isActive={activeCategory === cat} isDragging={String(activeCatId) === cat} onClick={() => setActiveCategory(cat)} />
                ))}
                <button onClick={() => setShowCategoryInput(v => !v)}
                  aria-label="添加新分类"
                  className="whitespace-nowrap px-3.5 py-1.5 text-xs rounded-lg border border-dashed border-border/50 text-muted-foreground/80 hover:text-foreground hover:border-border hover:bg-secondary/70 transition-all duration-200">
                  + 分类
                </button>
              </div>
            </SortableContext>
          </DndContext>
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
                className="flex-1 h-8 px-3 rounded-lg bg-secondary/80 text-xs border border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/30 transition-all duration-200"
                autoFocus
              />
              <button onClick={addCategory} className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity">创建</button>
              <button onClick={() => { setShowCategoryInput(false); setNewCategoryName(""); }} className="h-8 px-4 rounded-lg bg-secondary/70 text-xs text-muted-foreground hover:text-foreground transition-colors">取消</button>
            </div>
          )}
        </div>
      )}

      {/* 内容区 */}
      <div ref={contentRef} className="flex-1 overflow-y-auto px-5 pb-5 scroll-smooth">
        {/* 扫描中状态 */}
        {scanning && apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/80">
            <div className="w-16 h-16 mb-4 rounded-2xl bg-primary/5 flex items-center justify-center animate-float">
              <ScanLine className="w-8 h-8 text-primary/30" />
            </div>
            <p className="text-sm font-medium">正在扫描并分类应用...</p>
            <p className="text-xs mt-1.5 text-muted-foreground/60">首次启动会自动扫描开始菜单和桌面</p>
            <div className="flex gap-1 mt-3">
              <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        ) : view === "folders" && !searchQuery.trim() ? (
          (() => {
            return (
              <div className="flex flex-col gap-3">
                {/* 文件夹分类标签栏 */}
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleFolderCatDragStart} onDragEnd={handleFolderCatDragEnd}>
                  {/* 文件夹分类标签栏 */}
                  <div className="flex items-center justify-between">
                    <SortableContext items={folderCategories} strategy={horizontalListSortingStrategy}>
                      <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                        <button onClick={() => setActiveFolderCategory("全部")}
                          className={`whitespace-nowrap px-3.5 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${activeFolderCategory === "全部" ? "bg-primary text-primary-foreground shadow-md font-semibold animate-subtle-pulse" : "bg-secondary/50 text-foreground/80 hover:text-foreground hover:bg-accent/70"}`}>
                          全部
                        </button>
                        {folderCategories.map(cat => (
                          <SortableCatButton key={cat} id={cat} cat={cat} isActive={activeFolderCategory === cat} isDragging={String(activeFolderCatId) === cat} onClick={() => setActiveFolderCategory(cat)} />
                        ))}
                        <button onClick={() => setShowFolderCategoryInput(v => !v)}
                          className="whitespace-nowrap px-3.5 py-1.5 text-xs rounded-lg border border-dashed border-border/50 text-muted-foreground/80 hover:text-foreground hover:border-border hover:bg-secondary/70 transition-all duration-200">
                          + 分类
                        </button>
                      </div>
                    </SortableContext>
                    {showFolderCategoryInput && (
                      <div className="flex gap-1.5">
                        <input
                          value={newFolderCategoryName}
                          onChange={e => setNewFolderCategoryName(e.target.value)}
                          onKeyDown={async e => {
                            if (e.key === "Enter") {
                              const name = newFolderCategoryName.trim();
                              if (name && !folderCategories.some(c => c.toLowerCase() === name.toLowerCase())) {
                                try {
                                  await invoke("add_folder_category", { name });
                                  await loadFolderCategories();
                                  showToast(`已创建分类：${name}`, "ok");
                                  setNewFolderCategoryName("");
                                } catch (e) {
                                  console.warn("add_folder_category:", e);
                                  showToast(String(e), "err");
                                }
                              } else {
                                showToast("分类已存在或名称为空", "err");
                              }
                            }
                            if (e.key === "Escape") { setShowFolderCategoryInput(false); setNewFolderCategoryName(""); }
                          }}
                          placeholder="新分类名称"
                          className="h-6 px-2 rounded-lg bg-secondary text-xs border border-border focus:outline-none focus:ring-1 focus:ring-ring w-32"
                          autoFocus
                        />
                        <button onClick={async () => {
                          const name = newFolderCategoryName.trim();
                          if (name && !folderCategories.some(c => c.toLowerCase() === name.toLowerCase())) {
                            try {
                              await invoke("add_folder_category", { name });
                              await loadFolderCategories();
                              showToast(`已创建分类：${name}`, "ok");
                              setNewFolderCategoryName("");
                              setShowFolderCategoryInput(false);
                            } catch (e) {
                              console.warn("add_folder_category:", e);
                              showToast(String(e), "err");
                            }
                          }
                        }} className="h-6 px-2 rounded-lg bg-primary text-primary-foreground text-xs">创建</button>
                        <button onClick={() => { setShowFolderCategoryInput(false); setNewFolderCategoryName(""); }} className="h-6 px-2 rounded-lg bg-secondary text-xs text-muted-foreground">取消</button>
                      </div>
                    )}
                    <button onClick={() => setShowFolderInput(!showFolderInput)} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0" title="添加文件夹">
                      <FolderPlus className="w-4 h-4" />
                    </button>
                  </div>
                  {/* 添加文件夹表单 */}
                  {showFolderInput && (
                    <div className="flex flex-col gap-2 p-4 rounded-xl bg-secondary/80 border border-border/60 shadow-sm">
                      <input value={folderName} onChange={e => setFolderName(e.target.value)} placeholder="名称" className="h-8 px-3 rounded-lg bg-background/80 text-xs border border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/30 transition-all duration-200" />
                      <div className="flex gap-1.5">
                        <button onClick={pickFolderPath} className="h-8 px-3 rounded-lg bg-background/80 text-xs text-muted-foreground hover:text-foreground border border-border/60 shrink-0 transition-colors">
                          <Folder className="w-3.5 h-3.5 inline mr-1" />选择文件夹
                        </button>
                        {folderPath && (
                          <span className="h-8 px-3 flex items-center text-xs text-muted-foreground/80 truncate bg-background/80 rounded-lg border border-border/60 flex-1 min-w-0">{folderPath}</span>
                        )}
                      </div>
                      {/* 分类选择 */}
                      <select
                        value={newFolderCategory}
                        onChange={e => setNewFolderCategory(e.target.value)}
                        className="h-8 px-3 rounded-lg bg-background/80 text-xs border border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all duration-200"
                      >
                        {folderCategories.map(cat => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                      </select>
                      <div className="flex gap-1.5">
                        <button onClick={addFolder} disabled={!folderName || !folderPath} className="flex-1 h-8 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:opacity-90 transition-opacity">添加</button>
                        <button onClick={() => { setShowFolderInput(false); setFolderName(""); setFolderPath(""); }} className="h-8 px-4 rounded-lg bg-background/80 text-xs text-muted-foreground border border-border/60 hover:text-foreground transition-colors">取消</button>
                      </div>
                    </div>
                  )}
                  {/* 文件夹 grid */}
                  {filteredFolders.length > 0 ? (
                    <SortableContext items={filteredFolders.map(f => `folder-${f.id}`)} strategy={rectSortingStrategy}>
                      <div className="grid grid-cols-5 gap-2 p-1.5">
                        {filteredFolders.map((f, fi) => (
                          <SortableFolderCard key={f.id} folder={f} isSelected={fi === folderSelectedIndex}
                            isDragging={activeFolderCatId === `folder-${f.id}`}
                            onClick={() => openFolder(f.path)}
                            onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setCm(null); setFolderCm({ x: e.clientX, y: e.clientY, folder: f }); }}
                            onRemove={() => removeFolder(f.id)} />
                        ))}
                      </div>
                    </SortableContext>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/80">
                      <div className="w-16 h-16 mb-4 rounded-2xl bg-primary/5 flex items-center justify-center animate-float">
                        <Folder className="w-7 h-7 text-primary/30" />
                      </div>
                      <p className="text-sm font-medium">{activeFolderCategory === "全部" ? "还没有常用文件夹" : "该分类暂无文件夹"}</p>
                      <p className="text-xs mt-1.5 text-muted-foreground/60">点击右上角 + 添加常用目录</p>
                    </div>
                  )}
                </DndContext>
              </div>
            );
          })()
        ) : displayItems.length === 0 && !searchQuery.trim() && view === "panel" ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/80">
            <div className="w-16 h-16 mb-4 rounded-2xl bg-primary/5 flex items-center justify-center animate-float">
              <LayoutGrid className="w-7 h-7 text-primary/30" />
            </div>
            <p className="text-sm font-medium">该分类暂无应用</p>
            <p className="text-xs mt-1.5 text-muted-foreground/60">拖拽 exe 文件到这里添加</p>
          </div>
        ) : displayItems.length === 0 && !searchQuery.trim() && view === "search" ? (
          (() => {
            const topApps = apps.filter(a => a.use_count > 0).slice(0, 8);
            return (
              <div className="flex flex-col gap-4 py-2">
                {/* 搜索历史 */}
                {searchHistory.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5 tracking-wide uppercase">
                        <Clock className="w-3 h-3" />搜索历史
                      </span>
                      <button onClick={async () => {
                        try { await invoke("clear_search_history"); setSearchHistory([]); } catch (e) { console.warn("clearSearchHistory:", e); }
                      }} className="text-[11px] text-muted-foreground hover:text-destructive transition-colors">清空</button>
                    </div>
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
                      {searchHistory.slice(0, 10).map(q => (
                        <button key={q} onClick={() => { setSearchQuery(q); inputRef.current?.focus(); }}
                          className="px-3 py-1.5 rounded-lg bg-secondary/70 hover:bg-accent/80 text-xs whitespace-nowrap transition-all duration-200 hover:-translate-y-0.5 active:scale-95">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 常用应用 */}
                {topApps.length > 0 && (
                  <div>
                    <span className="text-[11px] font-medium text-muted-foreground mb-2 block tracking-wide uppercase">常用应用</span>
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => { setActiveAppDragId(Number(String(e.active.id).replace("topapp-grid-", ""))); }} onDragEnd={async e => {
                      setActiveAppDragId(null);
                      const { active, over } = e;
                      if (!over || active.id === over.id) return;
                      const ids = topApps.map((a: AppItem) => a.id);
                      const aid = Number(String(active.id).replace("topapp-grid-", ""));
                      const oid = Number(String(over.id).replace("topapp-grid-", ""));
                      const oi = ids.indexOf(aid); const ni = ids.indexOf(oid);
                      if (oi === -1 || ni === -1) return;
                      const reordered = arrayMove(ids, oi, ni);
                      try { await invoke("reorder_apps", { appIds: reordered }); await loadApps(); } catch (err) { console.warn(err); }
                    }}>
                      <SortableContext items={topApps.map((a: AppItem) => `topapp-grid-${a.id}`)} strategy={rectSortingStrategy}>
                        <div className="grid grid-cols-5 gap-2 p-1.5">
                          {topApps.map((app: AppItem) => (
                            <SortableTopAppGridCard key={app.id} app={app} iconCache={iconCache} isDragging={activeAppDragId === app.id} onClick={() => launchApp(app)} />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  </div>
                )}
                {/* 两者都无时显示空提示 */}
                {searchHistory.length === 0 && topApps.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/80">
                    <div className="w-16 h-16 mb-4 rounded-2xl bg-secondary/40 flex items-center justify-center">
                      <Search className="w-7 h-7 text-muted-foreground/30" />
                    </div>
                    <p className="text-sm font-medium">输入关键词搜索应用</p>
                  </div>
                )}
              </div>
            );
          })()
        ) : displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/80">
            <div className="w-16 h-16 mb-4 rounded-2xl bg-secondary/40 flex items-center justify-center">
              <Search className="w-7 h-7 text-muted-foreground/30" />
            </div>
            <p className="text-sm font-medium">{searchQuery ? "未找到匹配项" : "还没有应用"}</p>
            <p className="text-xs mt-1.5 text-muted-foreground/80">{searchQuery ? "试试其他关键词" : "拖拽 exe 文件到这里添加"}</p>
          </div>
        ) : (
          <>
            {/* 应用区域 */}
            {(() => {
              const appItems = displayItems.filter(i => i.type === "app" || i.type === "calc");
              const folderItems = displayItems.filter(i => i.type === "folder" || i.type === "file");
              const itemIndexMap = new Map<DisplayItem, number>();
              displayItems.forEach((item, idx) => itemIndexMap.set(item, idx));
              return (
                <>
                  {appItems.length > 0 && (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={e => setActiveAppDragId(Number(e.active.id))} onDragEnd={handleAppDragEnd}>
                      <SortableContext items={appIds} strategy={rectSortingStrategy}>
                        <div className="grid grid-cols-5 gap-2 p-1.5 animate-fade-in-up" style={{ contentVisibility: "auto" }}>
                          {appItems.map((item) => {
                            const idx = itemIndexMap.get(item) ?? 0;
                            if (item.type === "calc") return (
                              <div key="calc" className="col-span-5 flex items-center gap-3 p-3 rounded-xl transition-all" style={{ contentVisibility: "visible" }}>
                                <Calculator className="w-5 h-5 text-primary" />
                                <span className="text-lg font-mono font-bold text-foreground">{item.item.label}</span>
                              </div>
                            );
                            const app = item.item as AppItem;
                            return <AppCard key={app.id} app={app}
                              idx={idx} selectedIndex={selectedIndex}
                              searchQuery={searchQuery} iconCache={iconCache}
                              isDragging={activeAppDragId === app.id}
                              onClick={launchApp}
                              onContextMenu={(a2, cx, cy) => { setFolderCm(null); setCm({ x: cx, y: cy, app: a2 }); }}
                            />;
                          })}
                        </div>
                      </SortableContext>
                    </DndContext>
                  )}
                  {/* 文件夹/文件区域 — 分区显示，避免与应用混淆 */}
                  {folderItems.length > 0 && (
                    <div className="mt-3">
                      <span className="text-xs font-medium text-muted-foreground mb-1.5 block">
                        <Folder className="w-3.5 h-3.5 inline mr-1 text-primary" />文件夹
                      </span>
                      <div className="grid grid-cols-5 gap-2 p-1.5 animate-fade-in-up" style={{ contentVisibility: "auto" }}>
                        {folderItems.map((item) => {
                          const idx = itemIndexMap.get(item) ?? 0;
                          if (item.type === "file") {
                            const f = item.item as { name: string; path: string; is_dir: boolean };
                            return (
                              <button key={`file-${f.path}`} onClick={() => openFile(f.path)}
                                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-1 ring-ring/40 shadow-sm" : "hover:bg-accent/50"}`}
                                style={{ contentVisibility: "visible" }}>
                                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                                  <Folder className="w-7 h-7 text-blue-500" />
                                </div>
                                <span className="text-xs text-center text-foreground truncate w-full">{f.name}</span>
                                <span className="text-[9px] text-muted-foreground/80 truncate w-full">{f.is_dir ? "文件夹" : "文件"}</span>
                              </button>
                            );
                          }
                          const f = item.item as FolderItem;
                          return (
                            <button key={`f-${f.id}`} onClick={() => openFolder(f.path)}
                              className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl transition-all group ${idx === selectedIndex ? "bg-accent ring-1 ring-ring/40 shadow-sm" : "hover:bg-accent/50"}`}
                              onContextMenu={e => { e.preventDefault(); }}
                              style={{ contentVisibility: "visible" }}>
                              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                                <Folder className="w-7 h-7 text-primary" />
                              </div>
                              <span className="text-xs text-center text-foreground truncate w-full">{f.name}</span>
                              <span className="text-[9px] text-muted-foreground/80 truncate w-full">文件夹</span>
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

      {/* 右键菜单 — 应用 */}
      {cm && (
        <div className="fixed z-50 w-48 rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md p-1.5 shadow-xl shadow-black/8 animate-scale-in" style={(() => { const p = clampMenuPos(cm.x, cm.y); return { left: p.left, top: p.top }; })()} onClick={e => e.stopPropagation()}>
          <div className="px-2.5 py-1.5 mb-1 flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-secondary flex items-center justify-center text-[11px] font-bold shrink-0 ring-1 ring-border/20">
              {iconCache[cm.app.id] && iconCache[cm.app.id] !== "__failed__"
                ? <img src={iconCache[cm.app.id]} alt="" className="w-full h-full object-contain app-icon rounded" />
                : <span>{cm.app.name.charAt(0)}</span>}
            </div>
            <span className="text-xs font-medium text-foreground truncate">{cm.app.name}</span>
          </div>
          <div className="h-px bg-border/40 mb-1" />
          <button onClick={() => { launchApp(cm.app); setCm(null); }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]"><ExternalLink className="w-4 h-4 text-primary/70" />启动</button>
          <button onClick={() => togglePin(cm.app.id)} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]"><Pin className="w-4 h-4 text-muted-foreground" />{cm.app.is_pinned ? "取消固定" : "固定到顶部"}</button>
          <button onClick={() => { setCatDialog(cm.app); setCatInput(cm.app.category); setCm(null); setFolderCm(null); }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]"><FileType className="w-4 h-4 text-muted-foreground" />修改分类</button>
          <button onClick={async () => { try { await invoke("reveal_in_explorer", { path: cm.app.path }); } catch (e) { console.warn("reveal:", e); } setCm(null); }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]"><Folder className="w-4 h-4 text-muted-foreground" />打开所在文件夹</button>
          <div className="h-px bg-border/40 my-1" />
          <button onClick={() => removeApp(cm.app.id)} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-destructive/10 text-destructive transition-all duration-150 active:scale-[0.98]"><Trash2 className="w-4 h-4" />删除</button>
        </div>
      )}

      {/* 右键菜单 — 文件夹 */}
      {folderCm && (
        <div className="fixed z-50 w-48 rounded-xl border border-border/60 bg-popover/95 backdrop-blur-md p-1.5 shadow-xl shadow-black/8 animate-scale-in" style={(() => { const p = clampMenuPos(folderCm.x, folderCm.y); return { left: p.left, top: p.top }; })()}
          onClick={e => e.stopPropagation()}>
          <div className="px-2.5 py-1.5 mb-1 flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Folder className="w-4 h-4 text-primary" />
            </div>
            <span className="text-xs font-medium text-foreground truncate">{folderCm.folder.name}</span>
          </div>
          <div className="h-px bg-border/40 mb-1" />
          <button onClick={async () => {
            try { await openFolder(folderCm.folder.path); } catch (e) { showToast("打开失败", "err"); }
            setFolderCm(null);
          }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]">
            <ExternalLink className="w-4 h-4 text-primary/70" />打开
          </button>
          <button onClick={async () => {
            try { await invoke("reveal_in_explorer", { path: folderCm.folder.path }); } catch (e) { console.warn("reveal:", e); }
            setFolderCm(null);
          }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98]">
            <Folder className="w-4 h-4 text-muted-foreground" />打开所在文件夹
          </button>
          <div className="h-px bg-border/40 my-1" />
          <div className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground/70 tracking-wide">修改分类</div>
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
              }} className={`flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-accent/80 transition-all duration-150 active:scale-[0.98] ${cat === folderCm.folder.category ? "text-primary font-medium" : ""}`}>
                {cat === folderCm.folder.category && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                {cat}
              </button>
            ))}
          </div>
          <div className="h-px bg-border/40 my-1" />
          <button onClick={async () => {
            await removeFolder(folderCm.folder.id);
            setFolderCm(null);
          }} className="flex items-center gap-2.5 w-full px-2.5 py-2 text-sm rounded-lg hover:bg-destructive/10 text-destructive transition-all duration-150 active:scale-[0.98]">
            <Trash2 className="w-4 h-4" />删除
          </button>
        </div>
      )}

      {/* 修改分类对话框 */}
      {catDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm" onClick={() => setCatDialog(null)}>
          <div className="w-72 p-5 rounded-2xl bg-popover/95 backdrop-blur-md border border-border/60 shadow-xl shadow-black/5 animate-in fade-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-3">修改分类 — <span className="text-muted-foreground font-normal">{catDialog.name}</span></h3>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {categories.filter(c => c !== "全部").map(cat => (
                <button key={cat} onClick={() => { updateCategory(catDialog.id, cat); setCatDialog(null); }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all duration-200 ${cat === (catDialog?.category || "其他") ? "bg-primary text-primary-foreground shadow-sm" : "bg-secondary/70 text-muted-foreground hover:text-foreground hover:bg-secondary"}`}>
                  {cat}
                </button>
              ))}
            </div>
            <input value={catInput} onChange={e => setCatInput(e.target.value)} autoFocus placeholder="输入新分类名称..." className="w-full h-9 px-3 rounded-xl bg-secondary/80 text-xs border border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/30 transition-all duration-200 mb-3" />
            <button onClick={() => { if (catInput.trim()) updateCategory(catDialog.id, catInput.trim()); setCatDialog(null); }} className="w-full h-9 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity">确认</button>
          </div>
        </div>
      )}

      {/* AI 对话面板 */}
      {showAIChat && <AIChat onClose={() => setShowAIChat(false)} />}

      {/* 设置面板 */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Toast 通知 */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-popover/95 backdrop-blur-md border border-border/60 shadow-lg shadow-black/5 text-sm animate-in fade-in slide-in-from-bottom-3 duration-300">
          <div className={`w-1.5 h-1.5 rounded-full ${toast.type === "err" ? "bg-destructive" : "bg-primary"}`} />
          <span className={toast.type === "err" ? "text-destructive" : "text-foreground"}>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
