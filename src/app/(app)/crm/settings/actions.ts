"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { pinyin } from "pinyin-pro";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { toPermissionMessage } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const CLAIM_MODES = new Set(["self", "assign"]);

/** 由显示名称生成编码：「经销商」→ jing-xiao-shang，纯符号时退回 item-<时间> */
function codeFromLabel(label: string): string {
  const syllables = pinyin(label, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
  });
  const slug = syllables
    .join("-")
    .toLowerCase()
    .replace(/ü/g, "v")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || `item-${Date.now().toString(36)}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function toInt(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${field}必须是整数`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${field}需在 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

function refresh(): void {
  revalidatePath("/crm/settings");
  revalidatePath("/crm/accounts");
}

/** 字典项新增 / 修改：租户级配置，库策略只允许 L1 写入 */
export async function saveDictionaryItem(input: {
  id?: string;
  dictType: string;
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const id = text(input.id);
    const dictType = text(input.dictType);
    const rawCode = text(input.code);
    const label = text(input.label);
    const sort = toInt(input.sort ?? 0, "排序", 0, 9999);
    const enabled = Boolean(input.enabled);
    const autoCode = !id && !rawCode;
    const code = rawCode || (id ? "" : codeFromLabel(label));

    if (!dictType || dictType.length > 40) {
      throw new Error("字典类型必填且不超过 40 字符");
    }
    if (!id && (!code || code.length > 40)) {
      throw new Error("字典编码必填且不超过 40 字符");
    }
    if (!label || label.length > 80) {
      throw new Error("显示名称必填且不超过 80 字符");
    }
    if (context.accessLevel !== "L1") {
      throw new Error("字典是租户级配置，只有 L1 可以保存");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:dict_manage", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      if (id) {
        try {
          const updated = await client.query(
            `update trade_dictionaries
                set dict_type = $1, label = $2, sort = $3, enabled = $4, updated_at = now()
              where id = $5 and tenant_id = $6`,
            [dictType, label, sort, enabled, id, context.tenantId],
          );
          if (updated.rowCount === 0) {
            throw new Error("字典项不存在或无权修改");
          }
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            throw new Error("目标类型下该编码已存在，请先停用或修改另一条");
          }
          throw error;
        }
      } else {
        try {
          await client.query(
            `insert into trade_dictionaries (tenant_id, dict_type, code, label, sort, enabled)
             values ($1, $2, $3, $4, $5, $6)`,
            [context.tenantId, dictType, code, label, sort, enabled],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            throw new Error("同一字典类型下该编码已存在");
          }
          throw error;
        }
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: context.activeDepartmentId,
        action: id ? "crm.dictionary_updated" : "crm.dictionary_created",
        targetType: "trade_dictionary",
        targetId: id || undefined,
        payload: { dictType, code, label, sort, enabled },
      });
    });

    refresh();
    return {
      ok: true,
      message: id
        ? "字典项已更新"
        : autoCode
          ? `字典项已新增，编码为 ${code}`
          : "字典项已新增",
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 编号规则：前缀按编号类型维护，只影响之后生成的新编号 */
export async function saveCodeRule(input: {
  codeType: string;
  prefix: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const codeType = text(input.codeType);
    const prefix = text(input.prefix).toUpperCase();
    if (!codeType) {
      throw new Error("缺少编号类型");
    }
    if (!prefix || prefix.length > 4) {
      throw new Error("编号前缀必填且不超过 4 个字符");
    }
    if (!/^[A-Z0-9]+$/.test(prefix)) {
      throw new Error("编号前缀只能使用字母或数字");
    }
    if (context.accessLevel !== "L1") {
      throw new Error("编号规则是租户级配置，只有 L1 可以保存");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:dict_manage", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      await client.query("select app.save_trade_code_rule($1, $2)", [codeType, prefix]);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: context.activeDepartmentId,
        action: "crm.code_rule_saved",
        targetType: "trade_code_rule",
        payload: { codeType, prefix },
      });
    });

    refresh();
    return { ok: true, message: "编号规则已保存，从下一个编号开始生效" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 部门公共池策略：L1 或本部门 L2 */
export async function savePoolPolicy(input: {
  departmentId: string;
  holderCap: number;
  managerHolderCap: number;
  keyGradeThreshold: number;
  keyPendingTtlDays: number;
  claimMode: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const departmentId = text(input.departmentId);
    if (!departmentId) {
      throw new Error("请选择部门");
    }
    const holderCap = toInt(input.holderCap, "成员私海上限", 0, 100000);
    const managerHolderCap = toInt(input.managerHolderCap, "主管私海上限", 0, 100000);
    const keyGradeThreshold = toInt(input.keyGradeThreshold, "重点池阈值", 0, 100);
    const keyPendingTtlDays = toInt(input.keyPendingTtlDays, "候选有效期", 1, 90);
    const claimMode = text(input.claimMode);
    if (!CLAIM_MODES.has(claimMode)) {
      throw new Error("领取方式只支持自助或分配");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:pool_policy", {
        kind: "department",
        id: departmentId,
        departmentId,
      });

      const department = await client.query<{ name: string }>(
        "select name from departments where id = $1 and tenant_id = $2",
        [departmentId, context.tenantId],
      );
      if (department.rowCount === 0) {
        throw new Error("部门不存在");
      }

      await client.query(
        `insert into crm_pool_policies
           (tenant_id, department_id, holder_cap, manager_holder_cap,
            key_grade_threshold, key_pending_ttl_days, claim_mode, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (tenant_id, department_id) do update
           set holder_cap = excluded.holder_cap,
               manager_holder_cap = excluded.manager_holder_cap,
               key_grade_threshold = excluded.key_grade_threshold,
               key_pending_ttl_days = excluded.key_pending_ttl_days,
               claim_mode = excluded.claim_mode,
               updated_by = excluded.updated_by,
               updated_at = now()`,
        [
          context.tenantId,
          departmentId,
          holderCap,
          managerHolderCap,
          keyGradeThreshold,
          keyPendingTtlDays,
          claimMode,
          context.userId,
        ],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.pool_policy_saved",
        targetType: "department",
        targetId: departmentId,
        payload: {
          departmentName: department.rows[0]?.name ?? null,
          holderCap,
          managerHolderCap,
          keyGradeThreshold,
          keyPendingTtlDays,
          claimMode,
        },
      });
    });

    refresh();
    return { ok: true, message: "公共池策略已保存" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 个体私海上限：覆盖部门策略，可带有效期；上限留空表示按部门策略 */
export async function saveHolderCap(input: {
  userId: string;
  holderCap: number | null;
  reason: string;
  validUntil: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const userId = text(input.userId);
    if (!userId) {
      throw new Error("请选择成员");
    }
    const holderCap =
      input.holderCap === null || String(input.holderCap).trim() === ""
        ? null
        : toInt(input.holderCap, "私海上限", 0, 100000);
    const reason = text(input.reason);
    if (reason.length > 200) {
      throw new Error("原因不超过 200 字符");
    }
    const validUntil = text(input.validUntil);

    await withUserContext(context, async (client) => {
      const member = await client.query<{ department_id: string; name: string | null }>(
        `select m.department_id, u.name
           from memberships m
           join users u on u.id = m.user_id
          where m.user_id = $1 and m.tenant_id = $2 and m.status = 'active'
          order by m.created_at
          limit 1`,
        [userId, context.tenantId],
      );
      const target = member.rows[0];
      if (!target) {
        throw new Error("目标成员不存在或没有有效任用");
      }

      await requireContextPermission(client, context, "crm:holder_cap", {
        kind: "membership",
        id: context.activeMembershipId ?? undefined,
        departmentId: target.department_id,
      });

      await client.query(
        `insert into crm_holder_caps
           (tenant_id, user_id, holder_cap, reason, valid_from, valid_until, updated_by)
         values ($1, $2, $3, $4, now(), $5::timestamptz, $6)
         on conflict (tenant_id, user_id) do update
           set holder_cap = excluded.holder_cap,
               reason = excluded.reason,
               valid_from = now(),
               valid_until = excluded.valid_until,
               updated_by = excluded.updated_by,
               updated_at = now()`,
        [context.tenantId, userId, holderCap, reason || null, validUntil || null, context.userId],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: target.department_id,
        action: "crm.holder_cap_saved",
        targetType: "user",
        targetId: userId,
        payload: { memberName: target.name, holderCap, reason, validUntil: validUntil || null },
      });
    });

    refresh();
    return { ok: true, message: "个体上限已保存" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function removeHolderCap(input: { userId: string }): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const userId = text(input.userId);
    if (!userId) {
      throw new Error("成员 ID 缺失");
    }

    await withUserContext(context, async (client) => {
      const member = await client.query<{ department_id: string; name: string | null }>(
        `select m.department_id, u.name
           from memberships m
           join users u on u.id = m.user_id
          where m.user_id = $1 and m.tenant_id = $2
          order by m.created_at
          limit 1`,
        [userId, context.tenantId],
      );
      const target = member.rows[0];
      if (!target) {
        throw new Error("目标成员不存在");
      }

      await requireContextPermission(client, context, "crm:holder_cap", {
        kind: "membership",
        id: context.activeMembershipId ?? undefined,
        departmentId: target.department_id,
      });

      const removed = await client.query(
        "delete from crm_holder_caps where tenant_id = $1 and user_id = $2",
        [context.tenantId, userId],
      );
      if (removed.rowCount === 0) {
        throw new Error("该成员没有个体上限配置");
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: target.department_id,
        action: "crm.holder_cap_removed",
        targetType: "user",
        targetId: userId,
        payload: { memberName: target.name },
      });
    });

    refresh();
    return { ok: true, message: "已清除个体上限，回落到部门策略" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
