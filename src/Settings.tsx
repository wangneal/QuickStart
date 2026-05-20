import { useState, useEffect } from "react";
import { invoke } from "./lib/utils";
import { X, Sun, Moon, Monitor, Keyboard, Power, Cpu, LayoutGrid } from "lucide-react";

interface Props {
  onClose: () => void;
}

export default function Settings({ onClose }: Props) {
  const [aiProvider, setAiProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [autoStart, setAutoStart] = useState(true);
  const [autoClassify, setAutoClassify] = useState(true);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [saved, setSaved] = useState(false);

  // 从 SQLite 加载设置
  useEffect(() => {
    const load = async () => {
      try {
        const ac = await invoke<string>("get_setting", { key: "auto_classify" });
        if (ac) setAutoClassify(ac === "true");
        const th = await invoke<string>("get_setting", { key: "theme" });
        if (th) setTheme(th as any);
      } catch {}
    };
    load();
  }, []);

  const handleSave = async () => {
    try {
      await invoke("set_setting", { key: "auto_classify", value: autoClassify ? "true" : "false" });
      await invoke("set_setting", { key: "theme", value: theme });
    } catch {}
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div className="w-[420px] max-h-[80vh] flex flex-col rounded-2xl bg-popover border border-border shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* 标题 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold">设置</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* 外观 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Monitor className="w-4 h-4" /> 外观
            </h3>
            <div className="flex gap-2">
              {(["system", "light", "dark"] as const).map(t => (
                <button key={t} onClick={() => setTheme(t)}
                  className={`flex-1 flex items-center justify-center gap-1.5 h-9 rounded-lg text-xs transition-colors ${
                    theme === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}>
                  {t === "system" && <Monitor className="w-3.5 h-3.5" />}
                  {t === "light" && <Sun className="w-3.5 h-3.5" />}
                  {t === "dark" && <Moon className="w-3.5 h-3.5" />}
                  {t === "system" ? "跟随系统" : t === "light" ? "浅色" : "深色"}
                </button>
              ))}
            </div>
          </section>

          {/* 快捷键 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Keyboard className="w-4 h-4" /> 快捷键
            </h3>
            <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary">
              <span className="text-sm">呼出/隐藏</span>
              <kbd className="px-2.5 py-1 rounded-md bg-background border border-border text-xs font-mono">Alt + Space</kbd>
            </div>
          </section>

          {/* 启动 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Power className="w-4 h-4" /> 启动
            </h3>
            <label className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary cursor-pointer">
              <span className="text-sm">开机自启</span>
              <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-primary" />
            </label>
          </section>

          {/* 分类 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <LayoutGrid className="w-4 h-4" /> 应用分类
            </h3>
            <label className="flex items-center justify-between py-2 px-3 rounded-lg bg-secondary cursor-pointer">
              <div>
                <span className="text-sm">自动分类</span>
                <p className="text-xs text-muted-foreground mt-0.5">扫描后自动按关键词归类应用</p>
              </div>
              <input type="checkbox" checked={autoClassify} onChange={e => setAutoClassify(e.target.checked)}
                className="w-4 h-4 rounded border-border accent-primary" />
            </label>
          </section>

          {/* AI 配置 */}
          <section>
            <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Cpu className="w-4 h-4" /> AI 配置
            </h3>
            <div className="space-y-2.5">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">提供商</label>
                <select value={aiProvider} onChange={e => setAiProvider(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring">
                  <option value="openai">OpenAI</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="ollama">Ollama (本地)</option>
                  <option value="custom">自定义 (OpenAI 兼容)</option>
                </select>
              </div>
              {(aiProvider === "openai" || aiProvider === "claude" || aiProvider === "custom") && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                  <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
              {aiProvider === "custom" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Base URL</label>
                  <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1"
                    className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
              {aiProvider !== "ollama" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">模型</label>
                  <input value={model} onChange={e => setModel(e.target.value)}
                    className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              )}
              {aiProvider === "ollama" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">模型（如 llama3.2）</label>
                  <input value={model} onChange={e => setModel(e.target.value)} placeholder="llama3.2"
                    className="w-full h-9 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
                  <p className="text-[10px] text-muted-foreground mt-1">Ollama 默认地址: http://localhost:11434</p>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* 保存按钮 */}
        <div className="border-t border-border px-5 py-3">
          <button onClick={handleSave}
            className="w-full h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
            {saved ? "✓ 已保存" : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
