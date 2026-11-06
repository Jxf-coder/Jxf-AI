import Link from "next/link";

import { tabActive, tabBar, tabIdle } from "@/components/knowledge/tokens";

export const KNOWLEDGE_TABS = [
  { key: "cards", label: "知识卡" },
  { key: "scout", label: "巡读上传" },
  { key: "meta", label: "条目四字段" },
  { key: "gaps", label: "缺口" },
  { key: "qa", label: "问答来源" },
  { key: "regression", label: "回归题" },
] as const;

export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number]["key"];

export const DEFAULT_TAB: KnowledgeTab = "scout";

export function isKnowledgeTab(value: string | undefined): value is KnowledgeTab {
  return KNOWLEDGE_TABS.some((tab) => tab.key === value);
}

interface TabNavProps {
  active: KnowledgeTab;
  /** 右上角角标：待处理数量，0 / undefined 不显示 */
  counts?: Partial<Record<KnowledgeTab, number>>;
}

/** Tab 导航：状态全部由 URL 承载，刷新与分享不丢；键盘用普通 Tab 焦点顺序即可遍历 */
export function TabNav({ active, counts }: TabNavProps) {
  return (
    <nav className={`${tabBar} mb-4`} aria-label="知识库视图">
      {KNOWLEDGE_TABS.map((tab) => {
        const isActive = tab.key === active;
        const count = counts?.[tab.key];
        return (
          <Link
            key={tab.key}
            href={`/knowledge?tab=${tab.key}`}
            aria-current={isActive ? "page" : undefined}
            className={isActive ? tabActive : tabIdle}
          >
            {tab.label}
            {count ? (
              <span
                className={`ml-1.5 rounded-full px-1.5 text-[11px] font-semibold ${
                  isActive ? "bg-white/80 text-apple-blue" : "bg-amber-50 text-amber-600"
                }`}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
