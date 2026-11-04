"use client";

import { switchActiveDepartment } from "@/app/(app)/actions";
import { ChevronIcon } from "@/components/ui/icons";

export interface DepartmentOption {
  departmentId: string;
  departmentName: string;
  level: string;
}

/**
 * 多任用用户的部门上下文切换器。
 * 单选即提交；Cookie 由服务端写入并校验，客户端无法越权切换。
 */
export function DepartmentSwitcher({
  activeDepartmentId,
  memberships,
}: {
  activeDepartmentId: string | null;
  memberships: DepartmentOption[];
}) {
  if (memberships.length <= 1) {
    return null;
  }

  return (
    <form action={switchActiveDepartment} className="dept-switcher">
      <label className="dept-switcher-label" htmlFor="active-department">
        当前部门
      </label>
      <span className="dept-switcher-field">
        <select
          id="active-department"
          name="departmentId"
          key={activeDepartmentId ?? "none"}
          className="dept-switcher-select"
          defaultValue={activeDepartmentId ?? memberships[0]?.departmentId ?? ""}
          onChange={(event) => {
            event.currentTarget.form?.requestSubmit();
          }}
        >
          {memberships.map((membership) => (
            <option key={membership.departmentId} value={membership.departmentId}>
              {membership.departmentName} · {membership.level}
            </option>
          ))}
        </select>
        <ChevronIcon className="dept-switcher-chevron" size={13} />
      </span>
      <noscript>
        <button type="submit" className="button button-secondary">
          切换
        </button>
      </noscript>
    </form>
  );
}
