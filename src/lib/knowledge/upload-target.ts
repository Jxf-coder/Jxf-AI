/**
 * 目录预填上传目标：把左侧目录的一次点击解析成「部门 / 岗位 / 目录 / 范围」。
 *
 * 权限红线：
 * - L1 可以预填任意部门；
 * - L2 / 普通成员只能预填自己当前所在的部门，跨部门一律拒绝并给出明确提示
 *   （不允许默默回落到自己的部门，否则用户会以为传到了别处）；
 * - 岗位必须是该部门在职岗位，避免把资料挂到虚构岗位上；
 * - 「公司资料（共享）」只表达共享范围，归属部门仍是上传者当前部门，
 *   非 L1 选择时需要 L1 审批后才真正共享。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import {
  DEFAULT_DOCUMENT_FOLDER,
  folderLabel,
  isFolderKey,
  type FolderKey,
} from "@/lib/knowledge/folders";

export interface UploadTargetParams {
  folder?: string | null;
  dept?: string | null;
  role?: string | null;
  scope?: string | null;
}

export interface UploadTarget {
  ok: true;
  departmentId: string;
  departmentName: string;
  roleKey: string;
  folderKey: FolderKey;
  folderLabel: string;
  /** 是否上传到「公司资料（共享）」 */
  isShared: boolean;
  /** 非 L1 选择共享：需要 L1 审批后才真正共享 */
  needsApproval: boolean;
}

export interface UploadTargetError {
  ok: false;
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 同一目录既可能来自部门树（department），也可能来自共享区（shared） */
export function parseUploadScope(value: string | null | undefined): "department" | "shared" {
  return value === "shared" ? "shared" : "department";
}

export async function resolveUploadTarget(
  context: UserContext,
  params: UploadTargetParams,
): Promise<UploadTarget | UploadTargetError> {
  if (!context.activeDepartmentId) {
    return { ok: false, message: "当前账号没有有效部门上下文，无法确定上传目标" };
  }

  const requestedDept = (params.dept ?? "").trim();
  const roleKey = (params.role ?? "").trim().slice(0, 64);
  const folderKey: FolderKey = isFolderKey(params.folder) ? params.folder : DEFAULT_DOCUMENT_FOLDER;
  const isShared = parseUploadScope(params.scope) === "shared";

  const departmentId = requestedDept || context.activeDepartmentId;

  if (requestedDept && !UUID_RE.test(requestedDept)) {
    return { ok: false, message: "部门参数不合法" };
  }

  // 非 L1 只能预填当前部门；跨部门点击必须明确拦截，而不是静默回落
  if (context.accessLevel !== "L1" && departmentId !== context.activeDepartmentId) {
    return {
      ok: false,
      message: "无权限上传到该部门：请先在左下角切换到该部门，再选择目录",
    };
  }

  return withUserContext(context, async (client) => {
    const department = await client.query<{ id: string; name: string }>(
      `select id, name from departments where id = $1`,
      [departmentId],
    );
    const row = department.rows[0];
    if (!row) {
      return { ok: false as const, message: "该部门不存在或当前账号无权访问" };
    }

    if (roleKey) {
      const role = await client.query<{ exists: boolean }>(
        `select exists(
           select 1 from memberships
            where department_id = $1 and status = 'active' and trim(position) = $2
         ) as exists`,
        [departmentId, roleKey],
      );
      if (!role.rows[0]?.exists) {
        return { ok: false as const, message: `岗位「${roleKey}」在该部门不存在或已停用` };
      }
    }

    return {
      ok: true as const,
      departmentId: row.id,
      departmentName: row.name,
      roleKey,
      folderKey,
      folderLabel: folderLabel(folderKey),
      isShared,
      needsApproval: isShared && context.accessLevel !== "L1",
    };
  });
}
