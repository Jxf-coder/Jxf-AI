"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { sectionNav, sectionNavActive, sectionNavIdle } from "@/components/knowledge/tokens";

/**
 * 外贸CRM 板块的二级导航：板块只占侧栏一个入口，
 * 客户 / 产品 / 报价 / 合同 / 邮件 都收在右侧内容区的这一排「栏目」里。
 * 用下划线式而非胶囊，与页内的分段控件、详情页签拉开层级。
 */
const ITEMS: { href: string | null; label: string; stage?: string }[] = [
  { href: "/crm/accounts", label: "客户" },
  { href: null, label: "产品", stage: "W2" },
  { href: null, label: "报价", stage: "W2" },
  { href: null, label: "合同", stage: "W2" },
  { href: null, label: "邮件", stage: "W3" },
  { href: "/crm/settings", label: "设置" },
];

export function CrmTabs() {
  const pathname = usePathname();

  return (
    <nav className={sectionNav} aria-label="外贸CRM">
      {ITEMS.map((item) => {
        if (!item.href) {
          return (
            <span
              key={item.label}
              className={`${sectionNavIdle} cursor-default opacity-40`}
              title={`${item.stage} 上线`}
            >
              {item.label}
              <span className="ml-1 text-[10px] text-zinc-400">{item.stage}</span>
            </span>
          );
        }
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.label}
            href={item.href}
            className={active ? sectionNavActive : sectionNavIdle}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
