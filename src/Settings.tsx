import { useState, useEffect } from "react";
import { invoke } from "./lib/utils";
import { X, Sun, Moon, Monitor, Keyboard, Power, Cpu, LayoutGrid } from "lucide-react";

interface Props { onClose: () => void; }

const KEYS = {
  ai_provider: "openai", ai_api_key: "", ai_base_url: "", ai_model: "gpt-4o-mini",
  auto_start: "true", auto_classify: "true", theme: "system",
} as const;

type SettingKey = keyof typeof KEYS;

export default function Settings({ onClose }: Props) {
  const [s, setS] = useState<Record<string, string>>({...KEYS});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const r: Record<string,string> = {};
      for (const k of Object.keys(KEYS) as SettingKey[]) {
        try { r[k] = await invoke<string>("get_setting", { key: k }); } catch (e) { console.warn("get_setting:", k, e); r[k] = KEYS[k]; }
      }
      setS(r); setLoading(false);
    })();
  }, []);

  // System theme: listen to OS color scheme changes
  useEffect(() => {
    if (s.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      if (mq.matches) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [s.theme]);

  const set = (k: string, v: string) => setS(p => ({...p, [k]: v}));

  const save = async () => {
    for (const [k, v] of Object.entries(s)) {
      try { await invoke("set_setting", { key: k, value: v }); } catch (e) { console.warn("set_setting:", k, e); }
    }
    // 应用主题
    if (s.theme === "dark") {
      document.documentElement.classList.add("dark");
    } else if (s.theme === "light") {
      document.documentElement.classList.remove("dark");
    } else {
      // system: follow OS preference
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.matches) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
    }
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };

  if (loading) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div className="w-[420px] max-h-[80vh] flex flex-col rounded-2xl bg-popover border border-border shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">设置</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* 外观 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Monitor className="w-4 h-4" /> 外观</h3>
            <div className="flex gap-2">
              {(["system","light","dark"] as const).map(t => (
                <button key={t} onClick={() => set("theme", t)}
                  className={`flex-1 flex items-center justify-center gap-1.5 h-9 rounded-lg text-xs transition-colors ${s.theme === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {t === "system" ? <Monitor className="w-3.5 h-3.5" /> : t === "light" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                  {t === "system" ? "跟随系统" : t === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
          </section>

          {/* 快捷键 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Keyboard className="w-4 h-4" /> 快捷键</h3>
            <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary">
              <span className="text-sm">呼出/隐藏</span>
              <kbd className="px-2.5 py-1 rounded-md bg-background border border-border text-xs font-mono">Alt + Space</kbd>
            </div>
          </section>

          {/* 启动 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Power className="w-4 h-4" /> 启动</h3>
            <label className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary cursor-pointer">
              <span className="text-sm">开机自启</span>
              <input type="checkbox" checked={s.auto_start === "true"} onChange={e => set("auto_start", e.target.checked ? "true" : "false")} className="w-4 h-4 rounded border-border accent-primary" />
            </label>
          </section>

          {/* 分类 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><LayoutGrid className="w-4 h-4" /> 应用分类</h3>
            <label className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary cursor-pointer">
              <div><span className="text-sm">自动分类</span><p className="text-xs text-muted-foreground mt-0.5">扫描后自动归类应用</p></div>
              <input type="checkbox" checked={s.auto_classify === "true"} onChange={e => set("auto_classify", e.target.checked ? "true" : "false")} className="w-4 h-4 rounded border-border accent-primary" />
            </label>
          </section>

          {/* AI 配置 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Cpu className="w-4 h-4" /> AI 配置</h3>
            <div className="space-y-2.5">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">提供商</label>
                <select value={s.ai_provider} onChange={e => set("ai_provider", e.target.value)} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="ollama">Ollama (本地)</option>
                  <option value="custom">自定义 (OpenAI 兼容)</option>
                </select>
              </div>
              {(s.ai_provider === "openai" || s.ai_provider === "claude" || s.ai_provider === "custom") && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                  <input type="password" value={s.ai_api_key} onChange={e => set("ai_api_key", e.target.value)} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
              {s.ai_provider === "custom" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Base URL</label>
                  <input value={s.ai_base_url} onChange={e => set("ai_base_url", e.target.value)} placeholder="https://api.example.com/v1" className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
              {s.ai_provider !== "ollama" ? (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">模型</label>
                  <input value={s.ai_model} onChange={e => set("ai_model", e.target.value)} className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">模型（如 llama3.2）</label>
                  <input value={s.ai_model} onChange={e => set("ai_model", e.target.value)} placeholder="llama3.2" className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                  <p className="text-[10px] text-muted-foreground mt-1">Ollama 默认地址: http://localhost:11434</p>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="border-t border-border px-5 py-3 space-y-2">
          <p className="text-[10px] text-muted-foreground text-center">主题即改即生效，快捷键和开机自启需要重启应用</p>
          <button onClick={save} className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
            {saved ? "✓ 已保存" : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
