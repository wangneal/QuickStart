import { create } from "zustand";

export interface AppItem {
  id: number;
  name: string;
  path: string;
  icon_path: string | null;
  category: string;
  use_count: number;
  is_pinned: boolean;
  sort_order: number;
}

interface QuickStartState {
  /** 搜索文本 */
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  /** 应用列表 */
  apps: AppItem[];
  setApps: (apps: AppItem[]) => void;

  /** 窗口可见 */
  isVisible: boolean;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;

  /** 语音输入状态 */
  isListening: boolean;
  setListening: (v: boolean) => void;
}

export const useStore = create<QuickStartState>((set) => ({
  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),

  apps: [],
  setApps: (apps) => set({ apps }),

  isVisible: true,
  setVisible: (v) => set({ isVisible: v }),
  toggleVisible: () => set((s) => ({ isVisible: !s.isVisible })),

  isListening: false,
  setListening: (v) => set({ isListening: v }),
}));
