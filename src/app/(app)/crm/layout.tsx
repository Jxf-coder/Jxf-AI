import type { ReactNode } from "react";

import { CrmTabs } from "./CrmTabs";

/**
 * 外贸CRM 板块外壳：侧栏只有「外贸CRM」一个入口，
 * 客户 / 产品 / 报价 / 合同 / 邮件 在这排页签里切换，具体页面在其下方渲染。
 */
export default function CrmLayout({ children }: { children: ReactNode }) {
  return (
    <div className="w-full">
      <div className="mb-5">
        <CrmTabs />
      </div>
      {children}
    </div>
  );
}
