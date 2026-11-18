"use client";

import { useRef } from "react";

import { switchActiveDepartment } from "@/app/(app)/actions";
import { Select } from "@/components/ui/select";

export interface DepartmentOption {
  departmentId: string;
  departmentName: string;
  level: string;
}

/**
 * 多任用用户的部门上下文切换器。
 * 单选即提交；Cookie 由服务端写入并校验，客户端无法越权切换。
 * 下拉使用全局 ui/select，保证箭头间距与其他页面一致。
 */
export function DepartmentSwitcher({
  activeDepartmentId,
  memberships,
}: {
  activeDepartmentId: string | null;
  memberships: DepartmentOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);

  if (memberships.length <= 1) {
    return null;
  }

  return (
    <form ref={formRef} action={switchActiveDepartment} className="dept-switcher">
      <label className="dept-switcher-label" htmlFor="active-department">
        当前部门
      </label>
      <Select
        id="active-department"
        name="departmentId"
        key={activeDepartmentId ?? "none"}
        className="dept-switcher-control"
        defaultValue={activeDepartmentId ?? memberships[0]?.departmentId ?? ""}
        onValueChange={() => formRef.current?.requestSubmit()}
        options={memberships.map((membership) => ({
          value: membership.departmentId,
          label: `${membership.departmentName} · ${membership.level}`,
        }))}
      />
      <noscript>
        <button type="submit" className="button button-secondary">
          切换
        </button>
      </noscript>
    </form>
  );
}
