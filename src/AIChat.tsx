import { useState, useRef, useEffect } from "react";
import { invoke } from "./lib/utils";
import { Bot, Send, User, X, Mic, StopCircle } from "lucide-react";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface Props {
  onClose: () => void;
}

export default function AIChat({ onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "你好！我是 QuickStart AI 助手。我可以帮你整理文件夹、查找应用、回答问题。有什么需要帮忙的？" }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const speechRef = useRef<any>(null);
  const [streamingText, setStreamingText] = useState("");

  // 配置（正式应来自设置，现用默认）
  const config = {
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "", // 用户需在设置中配置
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setStreamingText("");

    try {
      // 监听 AI 事件
      const { listen } = await import("@tauri-apps/api/event");
      const unlistenToken = await listen<string>("ai:token", (event) => {
        setStreamingText((prev) => prev + event.payload);
      });

      const unlistenDone = await listen("ai:done", () => {
        unlistenToken();
        unlistenDone();
      });

      // 发送消息（加入安全指令和整理规则）
      const safetyMsg = { role: "system", content: [
        "你是 QuickStart AI 助手，运行在用户的 Windows 电脑上。",
        "",
        "【安全规则】",
        "⛔ 禁止删除或重命名任何文件",
        "⛔ 禁止修改文件内容",
        "✅ 可以读取目录列出来了解文件结构",
        "✅ 可以移动文件到分类文件夹来整理",
        "",
        "【文件整理规则】",
        "用 organize_folder('源路径', '目标目录') 按类型分类到桌面：",
        "- .exe .msi .bat .cmd .ps1 → 桌面/安装包",
        "- .zip .rar .7z .tar .gz .bz2 .xz → 桌面/压缩包",
        "- .jpg .jpeg .png .gif .bmp .webp .svg .ico .tiff → 桌面/图片",
        "- .doc .docx .xls .xlsx .ppt .pptx .pdf .txt → 桌面/文档",
        "- .md .csv .json .xml .html .htm → 桌面/数据",
        "- .mp4 .avi .mkv .mov .wmv .flv .webm → 桌面/视频",
        "- .mp3 .wav .flac .aac .ogg .wma .m4a → 桌面/音频",
        "- .js .ts .py .rs .go .java .cpp .c .cs .rb .php .vue .svelte .css .scss → 桌面/代码",
        "- .ttf .otf .woff .woff2 → 桌面/字体",
        "- 其他 → 桌面/其他",
        "",
        "【操作流程】",
        "1. 先用 list_directory 列出目录内容",
        "2. 根据文件类型决定目标分类文件夹",
        "3. 如果分类文件夹不存在，先问用户要不要创建",
        "4. 用 organize_folder 逐个移动文件",
        "5. 移动完成后总结一下移动了哪些文件",
        "",
        "【应用分类规则】",
        "根据名称归类：开发(VS Code/Git/IDE/终端/Docker/Node/数据库工具)、办公(WPS/Office/PDF/Notion/会议/思维导图)、浏览器(Chrome/Edge/Firefox)、娱乐(Steam/音乐/视频/直播/游戏)、设计(PS/Figma/Blender/AutoCAD/3D)、通讯(微信/QQ/钉钉/飞书/Telegram/Discord)、系统工具(压缩/截图/清理/驱动/Everything)、教育/其他",
      ].join("\n") };
      const msgsWithSafety = [safetyMsg, ...newMessages.map(m => ({ role: m.role, content: m.content }))];
      await invoke("ai_chat_stream", {
        messages: msgsWithSafety,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
    } catch (e) {
      console.error("AI 请求失败:", e);
      setStreamingText(`请求失败: ${e}. 请先在设置中配置 API Key。`);
    } finally {
      setLoading(false);
    }
  };

  // 当 streamingText 变化完毕后加入消息列表
  useEffect(() => {
    if (!loading && streamingText) {
      setMessages(prev => [...prev, { role: "assistant", content: streamingText }]);
      setStreamingText("");
    }
  }, [loading]);

  const toggleListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      speechRef.current?.stop();
      setListening(false);
      return;
    }
    const recognition = new SR();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e: any) => {
      setInput(prev => prev + e.results[0][0].transcript);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    speechRef.current = recognition;
    setListening(true);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" onClick={onClose}>
      <div className="w-[520px] h-[580px] flex flex-col rounded-2xl bg-popover border border-border shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-primary" />
            <span className="text-sm font-medium">QuickStart AI</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role !== "user" && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
              )}
              <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground rounded-tr-sm"
                  : "bg-muted rounded-tl-sm"
              }`}>
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{msg.content}</pre>
              </div>
              {msg.role === "user" && (
                <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-4 h-4 text-primary-foreground" />
                </div>
              )}
            </div>
          ))}

          {/* 流式输出 */}
          {streamingText && (
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="max-w-[80%] px-3 py-2 rounded-xl text-sm bg-muted rounded-tl-sm">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{streamingText}</pre>
              </div>
            </div>
          )}

          {loading && !streamingText && (
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="px-3 py-2 rounded-xl bg-muted">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay:"0ms"}} />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay:"150ms"}} />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay:"300ms"}} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入栏 */}
        <div className="px-4 py-3 border-t border-border">
          <div className="flex gap-2">
            <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) sendMessage(); }}
              placeholder={config.apiKey ? "输入消息..." : "请在设置中配置 AI API Key"}
              disabled={loading}
              className="flex-1 h-10 px-3 rounded-xl bg-secondary border border-border focus:outline-none focus:ring-2 focus:ring-ring text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50" />
            <button onClick={toggleListening} className={`p-2 rounded-xl transition-colors ${listening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
              <Mic className="w-4 h-4" />
            </button>
            <button onClick={sendMessage} disabled={loading || !input.trim()} className="p-2 rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
