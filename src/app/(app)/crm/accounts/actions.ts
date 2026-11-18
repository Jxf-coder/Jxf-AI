"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { toPermissionMessage } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";

export type AccountActionResult = { ok: true; message: string } | { ok: false; message: string };

/** 名称归一：去空白、标点与大小写，用于查重 */
function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[()（）【】\[\]·.,，。\-_/\\]/g, "");
}

const CONTACT_STATUS = ["untouched", "mailed", "wechat", "replied", "no_reply", "unreachable"];
const DEAL_STATUS = ["potential", "quoting", "negotiating", "won", "lost"];
const CONTACT_ROLE = ["decision", "tech", "purchase", "finance", "other"];
const GRADE_VALUES = ["A", "B", "C", "D"];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INTERACTION_DIRECTION = ["in", "out", "internal"];
const INTERACTION_CHANNEL = ["call", "mail", "wechat", "whatsapp", "meeting", "note", "task"];
const INTERACTION_STATUS = ["followed", "pending"];

const CHANNEL_LABELS: Record<string, string> = {
  call: "电话",
  mail: "邮件",
  wechat: "微信",
  whatsapp: "WhatsApp",
  meeting: "会面",
  note: "备注",
  task: "任务",
};
const DIRECTION_LABELS: Record<string, string> = {
  in: "客户发起",
  out: "我方发起",
  internal: "内部沟通",
};

/** 日期输入（yyyy-mm-dd）→ timestamptz；空值返回 null，非法值抛错 */
function toTimestamp(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`日期格式不正确：${value}`);
  }
  return date.toISOString();
}

/** 可编辑字段白名单：列名 → 中文名（也是修改历史里显示的字段名） */
const ACCOUNT_FIELDS: Record<string, string> = {
  name: "客户名称",
  company_name: "公司名称",
  region: "区域",
  country: "国家 / 地区",
  address: "地址",
  email: "电子邮箱",
  website: "公司网址",
  fax: "传真",
  postal_code: "邮政编码",
  sales_region: "销售区域",
  enterprise_type: "企业类型",
  brand: "品牌",
  sales_channel: "销售渠道",
  source: "客户来源",
  grade: "客户等级",
  customer_type: "客户类型",
  main_products: "主营产品",
  interested_products: "关注产品",
  competitors: "竞争对手",
  annual_revenue: "年营收",
  employee_count: "员工人数",
  founded_year: "成立年份",
  market_contact: "市场联系人",
  purchase_frequency: "采购频率",
  required_quality: "质量要求",
  traffic_content: "流量内容",
  analysis: "分析与备注",
  contact_status: "联系状态",
  deal_status: "成交状态",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function createAccount(input: {
  name: string;
  companyName: string;
  region: string;
  country: string;
  source: string;
  grade: string;
  customerType: string;
  email: string;
  website: string;
  phoneNote: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const name = input.name.trim();
    if (!name || name.length > 120) {
      throw new Error("客户名称必填且不超过 120 字符");
    }
    const email = input.email.trim();
    if (!email) {
      throw new Error("电子邮箱必填");
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new Error("邮箱格式不正确");
    }
    const grade = input.grade.trim().toUpperCase();
    if (!GRADE_VALUES.includes(grade)) {
      throw new Error("客户等级必须从 A / B / C / D 中选择");
    }
    const customerType = input.customerType.trim();
    if (!customerType) {
      throw new Error("客户类型必填");
    }
    const nameNorm = normalizeName(name);
    const departmentId = context.activeDepartmentId;
    if (!departmentId) {
      throw new Error("当前账号没有有效任用，无法建档");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: departmentId,
        departmentId,
      });

      const duplicate = await client.query<{ id: string; name: string; code: string }>(
        `select id, name, code
           from crm_accounts
          where tenant_id = $1
            and name_norm = $2
            and archived_at is null
          limit 1`,
        [context.tenantId, nameNorm],
      );
      if (duplicate.rowCount && duplicate.rows[0]) {
        const hit = duplicate.rows[0];
        throw new Error(`疑似重复客户：${hit.name}（${hit.code}）`);
      }

      // 可见范围内没有命中时，再按租户全量比对一次（跨部门同名不漏判，且不返回对方名称）
      const tenantDuplicate = await client.query<{ duplicated: boolean }>(
        "select app.crm_account_name_exists($1) as duplicated",
        [nameNorm],
      );
      if (tenantDuplicate.rows[0]?.duplicated) {
        throw new Error("租户内已有同名客户（可能在其他部门），请先与主管核对");
      }

      const codeResult = await client.query<{ code: string }>(
        "select app.next_trade_code($1, 'customer') as code",
        [context.tenantId],
      );
      const code = codeResult.rows[0]?.code ?? `C${Date.now()}`;

      const inserted = await client.query<{ id: string }>(
        `insert into crm_accounts (
           tenant_id, department_id, code, name, name_norm,
           company_name, region, country, email, website,
           source, grade, customer_type, analysis,
           owner_user_id, created_by
         ) values (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13, $14,
           $15, $15
         )
         returning id`,
        [
          context.tenantId,
          departmentId,
          code,
          name,
          nameNorm,
          input.companyName.trim() || null,
          input.region.trim() || null,
          input.country.trim() || null,
          email,
          input.website.trim() || null,
          input.source.trim() || null,
          grade,
          customerType,
          input.phoneNote.trim(),
          context.userId,
        ],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.account.created",
        targetType: "crm_account",
        targetId: inserted.rows[0]?.id ?? null,
        payload: { name, code },
      });
    });

    revalidatePath("/crm/accounts");
    return { ok: true, message: `已建档：${name}` };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 编辑客户档案：只写白名单字段，按前后值生成修改历史 */
export async function updateAccount(input: {
  accountId: string;
  fields: Record<string, string>;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = text(input.accountId);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (!context.activeDepartmentId) {
      throw new Error("当前账号没有有效任用");
    }

    const changes = Object.entries(input.fields)
      .filter(([key]) => Object.prototype.hasOwnProperty.call(ACCOUNT_FIELDS, key))
      .map(([key, value]) => ({ key, value: text(value) }));

    if (changes.length === 0) {
      throw new Error("没有可保存的字段");
    }

    let saved = 0;
    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const before = await client.query<Record<string, string | null> & { department_id: string }>(
        `select department_id, name, company_name, region, country, address, email, website,
                fax, postal_code, sales_region, enterprise_type, brand, sales_channel, source,
                grade, customer_type, main_products, interested_products, competitors,
                annual_revenue, employee_count, founded_year, market_contact,
                purchase_frequency, required_quality, traffic_content, analysis,
                contact_status, deal_status
           from crm_accounts
          where id = $1
            and archived_at is null`,
        [accountId],
      );
      const row = before.rows[0];
      if (!row) {
        throw new Error("客户不存在或你无权修改");
      }

      for (const change of changes) {
        if (change.key === "name" && (!change.value || change.value.length > 120)) {
          throw new Error("客户名称必填且不超过 120 字符");
        }
        if (change.key === "email") {
          if (!change.value) {
            throw new Error("电子邮箱必填");
          }
          if (!EMAIL_PATTERN.test(change.value)) {
            throw new Error("邮箱格式不正确");
          }
        }
        if (change.key === "grade") {
          change.value = change.value.toUpperCase();
          if (!GRADE_VALUES.includes(change.value)) {
            throw new Error("客户等级必须从 A / B / C / D 中选择");
          }
        }
        if (change.key === "customer_type" && !change.value) {
          throw new Error("客户类型必填");
        }
        if (change.key === "contact_status" && !CONTACT_STATUS.includes(change.value)) {
          throw new Error("联系状态取值非法");
        }
        if (change.key === "deal_status" && !DEAL_STATUS.includes(change.value)) {
          throw new Error("成交状态取值非法");
        }
      }

      const diff = changes.filter((change) => (row[change.key] ?? "") !== change.value);
      if (diff.length === 0) {
        return;
      }

      const params: unknown[] = [accountId];
      const assignments = diff.map((change) => {
        params.push(change.value || null);
        return `${change.key} = $${params.length}`;
      });
      if (diff.some((change) => change.key === "name")) {
        const nameChange = diff.find((change) => change.key === "name");
        params.push(normalizeName(nameChange?.value ?? ""));
        assignments.push(`name_norm = $${params.length}`);
      }

      const updated = await client.query(
        `update crm_accounts
            set ${assignments.join(", ")}, updated_at = now()
          where id = $1
            and archived_at is null`,
        params,
      );
      if (!updated.rowCount) {
        throw new Error("客户不存在或你无权修改");
      }
      saved = diff.length;

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: row.department_id,
        action: "crm.account.updated",
        targetType: "crm_account",
        targetId: accountId,
        payload: {
          changes: diff.map((change) => ({
            field: change.key,
            label: ACCOUNT_FIELDS[change.key],
            from: row[change.key] ?? "",
            to: change.value,
          })),
        },
      });
    });

    revalidatePath("/crm/accounts");
    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: saved > 0 ? `已保存 ${saved} 项修改` : "没有变化" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function createContact(input: {
  accountId: string;
  name: string;
  jobTitle: string;
  roleType: string;
  mobile: string;
  phone: string;
  email: string;
  wechat: string;
  whatsapp: string;
  isPrimary: boolean;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = text(input.accountId);
    const name = text(input.name);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (!name || name.length > 60) {
      throw new Error("联系人姓名必填且不超过 60 字符");
    }
    if (!context.activeDepartmentId) {
      throw new Error("当前账号没有有效任用");
    }
    const roleType = CONTACT_ROLE.includes(text(input.roleType)) ? text(input.roleType) : null;

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const account = await client.query<{ department_id: string }>(
        "select department_id from crm_accounts where id = $1 and archived_at is null",
        [accountId],
      );
      const accountRow = account.rows[0];
      if (!accountRow) {
        throw new Error("客户不存在或你无权修改");
      }

      if (input.isPrimary) {
        await client.query("update crm_contacts set is_primary = false where account_id = $1", [accountId]);
      }

      const inserted = await client.query<{ id: string }>(
        `insert into crm_contacts (
           tenant_id, department_id, account_id, name, job_title, role_type,
           mobile, phone, email, wechat, whatsapp, is_primary, created_by
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11, $12, $13
         )
         returning id`,
        [
          context.tenantId,
          accountRow.department_id,
          accountId,
          name,
          text(input.jobTitle) || null,
          roleType,
          text(input.mobile) || null,
          text(input.phone) || null,
          text(input.email) || null,
          text(input.wechat) || null,
          text(input.whatsapp) || null,
          Boolean(input.isPrimary),
          context.userId,
        ],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: accountRow.department_id,
        action: "crm.contact.created",
        targetType: "crm_account",
        targetId: accountId,
        payload: { contactId: inserted.rows[0]?.id ?? null, name },
      });
    });

    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: `已添加联系人：${name}` };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function deleteContact(input: {
  accountId: string;
  contactId: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = text(input.accountId);
    const contactId = text(input.contactId);
    if (!accountId || !contactId) {
      throw new Error("缺少联系人标识");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const account = await client.query<{ department_id: string }>(
        "select department_id from crm_accounts where id = $1 and archived_at is null",
        [accountId],
      );
      const accountRow = account.rows[0];
      if (!accountRow) {
        throw new Error("客户不存在或你无权修改");
      }

      const deleted = await client.query(
        "delete from crm_contacts where id = $1 and account_id = $2",
        [contactId, accountId],
      );
      if (!deleted.rowCount) {
        throw new Error("联系人不存在或你无权删除");
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: accountRow.department_id,
        action: "crm.contact.deleted",
        targetType: "crm_account",
        targetId: accountId,
        payload: { contactId },
      });
    });

    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: "已删除联系人" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// 公共池流转：领用 / 置公 / 定向分配 / 重点池裁决
// 规则校验在数据库函数里（部门范围、三层上限、状态机），这里只做功能权限与审计。
// ---------------------------------------------------------------------------

async function loadAccountDepartment(client: PoolClient, accountId: string): Promise<string> {
  const account = await client.query<{ department_id: string }>(
    "select department_id from crm_accounts where id = $1 and archived_at is null",
    [accountId],
  );
  const row = account.rows[0];
  if (!row) {
    throw new Error("客户不存在或你无权操作");
  }
  return row.department_id;
}

export async function mergeAccount(input: {
  sourceId: string;
  targetId: string;
  reason: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const sourceId = text(input.sourceId);
    const targetId = text(input.targetId);
    const reason = text(input.reason);
    if (!sourceId || !targetId) {
      throw new Error("请选择要合并到的目标客户");
    }
    if (sourceId === targetId) {
      throw new Error("不能把客户合并到自己");
    }
    if (!reason) {
      throw new Error("合并原因必填");
    }

    let stats: { source_code?: string; target_code?: string; contacts?: number } = {};
    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:merge", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = await loadAccountDepartment(client, sourceId);
      const result = await client.query<{
        result: { source_code: string; target_code: string; contacts: number };
      }>("select app.crm_merge_accounts($1, $2, $3) as result", [sourceId, targetId, reason]);
      stats = result.rows[0]?.result ?? {};

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.account.merged",
        targetType: "crm_account",
        targetId: sourceId,
        payload: { ...stats, reason },
      });
    });

    revalidatePath("/crm/accounts");
    revalidatePath(`/crm/accounts/${sourceId}`);
    revalidatePath(`/crm/accounts/${targetId}`);
    return {
      ok: true,
      message: `已并入 ${stats.target_code ?? "目标客户"}，迁移联系人 ${stats.contacts ?? 0} 位`,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function claimAccount(input: { accountId: string }): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const accountId = text(input.accountId);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (context.accessLevel !== "L1") {
      throw new Error("L2 / L3 请提交领用申请，由上级审批");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:claim", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = await loadAccountDepartment(client, accountId);
      await client.query("select app.crm_pool_claim($1)", [accountId]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.pool.claimed",
        targetType: "crm_account",
        targetId: accountId,
      });
    });

    revalidatePath("/crm/accounts");
    return { ok: true, message: "已领用，客户进入你的私海" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** L2 / L3 提交领用申请：只登记意图，不改客户归属，等上级审批 */
export async function requestClaimAccount(input: { accountId: string }): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const accountId = text(input.accountId);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }

    await withUserContext(context, async (client) => {
      // crm:claim 只授予 SELF：申请是「为本人领用」，资源按当前任用判定
      await requireContextPermission(client, context, "crm:claim", {
        kind: "membership",
        id: context.activeMembershipId ?? undefined,
        departmentId: context.activeDepartmentId,
        ownerUserId: context.userId,
      });

      const departmentId = await loadAccountDepartment(client, accountId);
      const created = await client.query<{ id: string }>(
        "select app.crm_pool_request_claim($1) as id",
        [accountId],
      );
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.pool.claim_requested",
        targetType: "crm_account",
        targetId: accountId,
        payload: { requestId: created.rows[0]?.id ?? null },
      });
    });

    revalidatePath("/crm/accounts");
    return { ok: true, message: "已提交领用申请，等待上级审批" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 审批领用申请：L1，或该申请部门的 L2（只能审批 L3 的申请） */
export async function decideClaimRequest(input: {
  requestId: string;
  approve: boolean;
  note?: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const claimRequestId = text(input.requestId);
    const note = text(input.note ?? "");
    if (!claimRequestId) {
      throw new Error("缺少申请标识");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:assign", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const target = await client.query<{
        account_id: string;
        requester_user_id: string;
        department_id: string;
      }>(
        `select account_id, requester_user_id, department_id
           from crm_claim_requests
          where id = $1`,
        [claimRequestId],
      );
      const row = target.rows[0];
      if (!row) {
        throw new Error("申请不存在或无权审批");
      }

      await client.query("select app.crm_pool_decide_claim($1, $2, $3)", [
        claimRequestId,
        Boolean(input.approve),
        note || null,
      ]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: row.department_id,
        action: input.approve ? "crm.pool.claim_approved" : "crm.pool.claim_rejected",
        targetType: "crm_account",
        targetId: row.account_id,
        payload: {
          requestId: claimRequestId,
          requesterUserId: row.requester_user_id,
          note,
        },
      });
    });

    revalidatePath("/crm/accounts");
    return {
      ok: true,
      message: input.approve ? "已通过领用申请，客户进入申请人私海" : "已驳回领用申请",
    };
  } catch (error) {
    const message = toPermissionMessage(error);
    if (/request is not pending/i.test(message)) {
      return { ok: false, message: "该申请已被其他审批人处理，请刷新后查看" };
    }
    if (/cannot decide your own request/i.test(message)) {
      return { ok: false, message: "不能审批自己提交的申请" };
    }
    return { ok: false, message };
  }
}

export async function releaseAccount(input: {
  accountId: string;
  reason: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const accountId = text(input.accountId);
    const reason = text(input.reason);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (!reason) {
      throw new Error("置公必须填写原因");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = await loadAccountDepartment(client, accountId);
      await client.query("select app.crm_pool_release($1, $2)", [accountId, reason]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.pool.released",
        targetType: "crm_account",
        targetId: accountId,
        payload: { reason },
      });
    });

    revalidatePath("/crm/accounts");
    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: "已置入公共池" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function assignAccount(input: {
  accountId: string;
  toUserId: string;
  reason: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const accountId = text(input.accountId);
    const toUserId = text(input.toUserId);
    const reason = text(input.reason);
    if (!accountId || !toUserId) {
      throw new Error("请选择要分配的成员");
    }
    if (context.accessLevel !== "L1" && context.accessLevel !== "L2") {
      throw new Error("只有 L1 / L2 可以分配客户");
    }

    let capExceeded = false;
    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:assign", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = await loadAccountDepartment(client, accountId);
      const result = await client.query<{ exceeded: boolean }>(
        "select app.crm_pool_assign($1, $2, $3) as exceeded",
        [accountId, toUserId, reason],
      );
      capExceeded = Boolean(result.rows[0]?.exceeded);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: "crm.pool.assigned",
        targetType: "crm_account",
        targetId: accountId,
        payload: { toUserId, reason, capExceeded },
      });
    });

    revalidatePath("/crm/accounts");
    revalidatePath(`/crm/accounts/${accountId}`);
    return {
      ok: true,
      message: capExceeded ? "已分配，但对方私海已超上限" : "已分配",
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function confirmKeyAccount(input: {
  accountId: string;
  confirm: boolean;
  reason: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const accountId = text(input.accountId);
    const reason = text(input.reason);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (!reason) {
      throw new Error("重点池裁决必须填写原因");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:assign", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = await loadAccountDepartment(client, accountId);
      await client.query("select app.crm_pool_confirm_key($1, $2, $3)", [
        accountId,
        Boolean(input.confirm),
        reason || null,
      ]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId,
        action: input.confirm ? "crm.pool.key_confirmed" : "crm.pool.key_downgraded",
        targetType: "crm_account",
        targetId: accountId,
        payload: { reason },
      });
    });

    revalidatePath("/crm/accounts");
    return { ok: true, message: input.confirm ? "已确认进入重点池" : "已降级回普通公海" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// 联系记录（交互时间线）
// ---------------------------------------------------------------------------

export async function createInteraction(input: {
  accountId: string;
  contactId: string;
  purpose: string;
  direction: string;
  channel: string;
  occurredAt: string;
  nextFollowAt: string;
  subject: string;
  content: string;
  status: string;
  isOpportunity: boolean;
  interestedProducts: string;
  category: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = text(input.accountId);
    if (!accountId) {
      throw new Error("缺少客户标识");
    }
    if (!INTERACTION_DIRECTION.includes(input.direction)) {
      throw new Error("沟通方向取值非法");
    }
    if (!INTERACTION_CHANNEL.includes(input.channel)) {
      throw new Error("沟通方式取值非法");
    }
    if (!INTERACTION_STATUS.includes(input.status)) {
      throw new Error("记录状态取值非法");
    }
    const occurredAt = toTimestamp(input.occurredAt) ?? new Date().toISOString();
    const nextFollowAt = toTimestamp(input.nextFollowAt);
    if (input.status === "pending" && !nextFollowAt) {
      throw new Error("待跟进记录必须填写下次跟进日期");
    }
    const subject = text(input.subject);
    if (!subject || subject.length > 120) {
      throw new Error("主题必填且不超过 120 字符");
    }
    const contactId = text(input.contactId) || null;

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const account = await client.query<{ department_id: string }>(
        "select department_id from crm_accounts where id = $1 and archived_at is null",
        [accountId],
      );
      const accountRow = account.rows[0];
      if (!accountRow) {
        throw new Error("客户不存在或你无权操作");
      }

      if (contactId) {
        const contact = await client.query<{ id: string }>(
          "select id from crm_contacts where id = $1 and account_id = $2",
          [contactId, accountId],
        );
        if (!contact.rowCount) {
          throw new Error("联系人不存在或不属于该客户");
        }
      }

      const inserted = await client.query<{ id: string }>(
        `insert into crm_interactions (
           tenant_id, department_id, account_id, contact_id, owner_user_id,
           purpose, direction, channel, occurred_at, next_follow_at,
           subject, content, status, is_opportunity, interested_products,
           category, created_by
         ) values (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15,
           $16, $5
         )
         returning id`,
        [
          context.tenantId,
          accountRow.department_id,
          accountId,
          contactId,
          context.userId,
          text(input.purpose) || null,
          input.direction,
          input.channel,
          occurredAt,
          nextFollowAt,
          subject,
          text(input.content) || null,
          input.status,
          Boolean(input.isOpportunity),
          text(input.interestedProducts) || null,
          text(input.category) || null,
        ],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: accountRow.department_id,
        action: "crm.interaction.created",
        targetType: "crm_account",
        targetId: accountId,
        payload: {
          interactionId: inserted.rows[0]?.id ?? null,
          changes: [
            { field: "subject", label: "主题", from: "", to: subject },
            {
              field: "channel",
              label: "沟通方式",
              from: "",
              to: CHANNEL_LABELS[input.channel] ?? input.channel,
            },
            {
              field: "direction",
              label: "方向",
              from: "",
              to: DIRECTION_LABELS[input.direction] ?? input.direction,
            },
            {
              field: "status",
              label: "记录状态",
              from: "",
              to: input.status === "pending" ? "待跟进" : "已跟进",
            },
            { field: "occurred_at", label: "跟进日期", from: "", to: occurredAt.slice(0, 10) },
            { field: "next_follow_at", label: "下次跟进", from: "", to: nextFollowAt?.slice(0, 10) ?? "" },
          ],
        },
      });
    });

    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: "已记录联系情况" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function deleteInteraction(input: {
  accountId: string;
  interactionId: string;
}): Promise<AccountActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = text(input.accountId);
    const interactionId = text(input.interactionId);
    if (!accountId || !interactionId) {
      throw new Error("缺少记录标识");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const before = await client.query<{
        subject: string;
        channel: string;
        status: string;
        next_follow_at: Date | null;
        department_id: string;
      }>(
        `select subject, channel, status, next_follow_at, department_id
           from crm_interactions
          where id = $1 and account_id = $2`,
        [interactionId, accountId],
      );
      const record = before.rows[0];
      if (!record) {
        throw new Error("记录不存在或你无权删除");
      }

      const deleted = await client.query(
        "delete from crm_interactions where id = $1 and account_id = $2",
        [interactionId, accountId],
      );
      if (!deleted.rowCount) {
        throw new Error("记录不存在或你无权删除");
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: record.department_id,
        action: "crm.interaction.deleted",
        targetType: "crm_account",
        targetId: accountId,
        payload: {
          interactionId,
          changes: [
            { field: "subject", label: "主题", from: record.subject, to: "" },
            {
              field: "channel",
              label: "沟通方式",
              from: CHANNEL_LABELS[record.channel] ?? record.channel,
              to: "",
            },
            {
              field: "status",
              label: "记录状态",
              from: record.status === "pending" ? "待跟进" : "已跟进",
              to: "",
            },
            {
              field: "next_follow_at",
              label: "下次跟进",
              from: record.next_follow_at ? record.next_follow_at.toISOString().slice(0, 10) : "",
              to: "",
            },
          ],
        },
      });
    });

    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: "已删除联系记录" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// 批量导入：先 dry-run 出逐行回执，再确认写入；两类操作走同一套校验
// ---------------------------------------------------------------------------

export interface ImportRowResult {
  line: number;
  name: string;
  status: "ok" | "error";
  errors: string[];
}

export interface ImportPreview {
  rows: ImportRowResult[];
  summary: { total: number; ok: number; error: number };
}

export type ImportPreviewResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; message: string };

export type ImportCommitResult =
  | { ok: true; message: string; preview: ImportPreview }
  | { ok: false; message: string };

const IMPORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "客户名称" },
  { key: "companyName", label: "公司名称" },
  { key: "country", label: "国家" },
  { key: "region", label: "区域" },
  { key: "source", label: "客户来源" },
  { key: "grade", label: "客户等级" },
  { key: "customerType", label: "客户类型" },
  { key: "email", label: "邮箱" },
  { key: "website", label: "网址" },
  { key: "note", label: "备注" },
];

const IMPORT_MAX_ROWS = 500;

/** 最小 CSV 解析：支持双引号包裹与 "" 转义，跳过纯空行 */
function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quoted) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim());
      if (row.some((item) => item !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some((item) => item !== "")) {
    rows.push(row);
  }
  return rows;
}

interface ImportAnalysis {
  rows: ImportRowResult[];
  valid: { line: number; values: Record<string, string>; extra: Record<string, string> }[];
}

/** 逐行校验：必填、长度、邮箱格式、文件内重复、租户内同名、字典取值 */
async function analyzeImport(
  client: PoolClient,
  csv: string,
  tenantId: string,
): Promise<ImportAnalysis> {
  const grid = parseCsv(csv);
  if (grid.length === 0) {
    throw new Error("CSV 内容为空");
  }

  const dictResult = await client.query<{ dict_type: string; code: string; label: string }>(
    `select dict_type, code, label
       from trade_dictionaries
      where tenant_id = $1 and enabled
      order by dict_type, sort, code`,
    [tenantId],
  );
  const dictByType = new Map<string, { code: string; label: string }[]>();
  for (const row of dictResult.rows) {
    const bucket = dictByType.get(row.dict_type) ?? [];
    bucket.push({ code: row.code, label: row.label });
    dictByType.set(row.dict_type, bucket);
  }

  /** 字典有配置时按字典校验并回写标准编码；未配置的类型不额外限制 */
  const matchDict = (
    dictType: string,
    value: string,
  ): { ok: boolean; canonical: string } => {
    const items = dictByType.get(dictType);
    if (!items || items.length === 0) {
      return { ok: true, canonical: value };
    }
    const target = value.trim().toLowerCase();
    const hit = items.find(
      (item) =>
        item.code.toLowerCase() === target || item.label.trim().toLowerCase() === target,
    );
    return hit ? { ok: true, canonical: hit.code } : { ok: false, canonical: value };
  };

  const labels = IMPORT_COLUMNS.map((column) => column.label);
  const hasHeader = grid[0].some((cell) => labels.includes(cell) || cell === "名称");
  const header = hasHeader ? grid[0] : null;
  const body = hasHeader ? grid.slice(1) : grid;

  if (body.length === 0) {
    throw new Error("CSV 只有表头，没有数据行");
  }
  if (body.length > IMPORT_MAX_ROWS) {
    throw new Error(`单次最多导入 ${IMPORT_MAX_ROWS} 行，请拆分文件`);
  }

  const columnIndex = (key: string, label: string): number => {
    if (!header) {
      return IMPORT_COLUMNS.findIndex((column) => column.key === key);
    }
    const exact = header.findIndex((cell) => cell === label);
    if (exact >= 0) {
      return exact;
    }
    return header.findIndex((cell) => cell === "名称" && key === "name");
  };

  const indexes = Object.fromEntries(
    IMPORT_COLUMNS.map((column) => [column.key, columnIndex(column.key, column.label)]),
  ) as Record<string, number>;

  const rows: ImportRowResult[] = [];
  const valid: { line: number; values: Record<string, string>; extra: Record<string, string> }[] = [];
  const seen = new Map<string, number>();

  for (let offset = 0; offset < body.length; offset += 1) {
    const cells = body[offset];
    const line = offset + (hasHeader ? 2 : 1);
    const values: Record<string, string> = {};
    for (const column of IMPORT_COLUMNS) {
      const index = indexes[column.key];
      values[column.key] = index >= 0 ? (cells[index] ?? "").trim() : "";
    }

    const errors: string[] = [];
    const name = values.name;
    const nameNorm = name ? normalizeName(name) : "";

    if (!name) {
      errors.push("客户名称不能为空");
    } else if (name.length > 120) {
      errors.push("客户名称超过 120 字符");
    }
    if (!values.email) {
      errors.push("邮箱不能为空");
    } else if (!EMAIL_PATTERN.test(values.email)) {
      errors.push("邮箱格式不正确");
    }
    if (!values.grade) {
      errors.push("客户等级不能为空");
    } else if (!GRADE_VALUES.includes(values.grade.toUpperCase())) {
      errors.push("客户等级只能是 A / B / C / D");
    } else {
      values.grade = values.grade.toUpperCase();
      const matched = matchDict("customer_grade", values.grade);
      if (!matched.ok) {
        errors.push(`客户等级不在字典中：${values.grade}`);
      } else {
        values.grade = matched.canonical;
      }
    }
    if (!values.customerType) {
      errors.push("客户类型不能为空");
    } else {
      const matched = matchDict("customer_type", values.customerType);
      if (!matched.ok) {
        errors.push(`客户类型不在字典中：${values.customerType}`);
      } else {
        values.customerType = matched.canonical;
      }
    }
    for (const [key, dictType, label] of [
      ["source", "customer_source", "客户来源"],
      ["region", "customer_region", "区域"],
      ["country", "customer_country", "国家"],
    ] as const) {
      if (!values[key]) {
        continue;
      }
      const matched = matchDict(dictType, values[key]);
      if (!matched.ok) {
        errors.push(`${label}不在字典中：${values[key]}`);
      } else {
        values[key] = matched.canonical;
      }
    }

    // 未映射的列原样存进 extra.import，避免导入时丢字段
    const extra: Record<string, string> = {};
    if (header) {
      header.forEach((cell, index) => {
        if (!cell) {
          return;
        }
        const mapped =
          cell === "名称" || IMPORT_COLUMNS.some((column) => column.label === cell);
        if (mapped) {
          return;
        }
        const value = (cells[index] ?? "").trim();
        if (value) {
          extra[cell] = value;
        }
      });
    }
    if (nameNorm) {
      const duplicateLine = seen.get(nameNorm);
      if (duplicateLine) {
        errors.push(`与本文件第 ${duplicateLine} 行重复`);
      } else {
        seen.set(nameNorm, line);
        const exists = await client.query<{ duplicated: boolean }>(
          "select app.crm_account_name_exists($1) as duplicated",
          [nameNorm],
        );
        if (exists.rows[0]?.duplicated) {
          errors.push("租户内已存在同名客户");
        }
      }
    }

    rows.push({ line, name, status: errors.length ? "error" : "ok", errors });
    if (errors.length === 0) {
      valid.push({ line, values, extra });
    }
  }

  return { rows, valid };
}

function summarize(rows: ImportRowResult[]): ImportPreview {
  const ok = rows.filter((row) => row.status === "ok").length;
  return { rows, summary: { total: rows.length, ok, error: rows.length - ok } };
}

export async function previewAccountImport(input: { csv: string }): Promise<ImportPreviewResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const preview = await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:import", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });
      const analysis = await analyzeImport(client, text(input.csv), context.tenantId);
      return summarize(analysis.rows);
    });

    return { ok: true, preview };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function commitAccountImport(input: { csv: string }): Promise<ImportCommitResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const preview = await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "crm:import", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });
      await requireContextPermission(client, context, "crm:write", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const departmentId = context.activeDepartmentId;
      if (!departmentId) {
        throw new Error("当前账号没有有效任用，无法导入");
      }

      const analysis = await analyzeImport(client, text(input.csv), context.tenantId);
      if (analysis.valid.length === 0) {
        throw new Error("没有可导入的行，请先修正错误");
      }

      for (const row of analysis.valid) {
        const name = row.values.name;
        // 取号后先确认未被占用：历史数据修复或直接写库可能让序号落后于存量编号
        let code = "";
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const codeResult = await client.query<{ code: string }>(
            "select app.next_trade_code($1, 'customer') as code",
            [context.tenantId],
          );
          const candidate = codeResult.rows[0]?.code ?? `C${Date.now()}`;
          const taken = await client.query(
            "select 1 from crm_accounts where tenant_id = $1 and code = $2",
            [context.tenantId, candidate],
          );
          code = candidate;
          if (taken.rowCount === 0) {
            break;
          }
        }
        const inserted = await client.query<{ id: string }>(
          `insert into crm_accounts (
             tenant_id, department_id, code, name, name_norm,
             company_name, country, region, source, grade, customer_type,
             email, website, analysis, owner_user_id, created_by, extra
           ) values (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $15, $16::jsonb
           )
           returning id`,
          [
            context.tenantId,
            departmentId,
            code,
            name,
            normalizeName(name),
            row.values.companyName || null,
            row.values.country || null,
            row.values.region || null,
            row.values.source || null,
            row.values.grade || null,
            row.values.customerType || null,
            row.values.email || null,
            row.values.website || null,
            row.values.note || null,
            context.userId,
            Object.keys(row.extra).length > 0 ? JSON.stringify({ import: row.extra }) : "{}",
          ],
        );
        const accountId = inserted.rows[0]?.id;
        if (!accountId) {
          throw new Error("导入写入失败");
        }
        await auditInTx(client, context, {
          actorUserId: context.userId,
          departmentId,
          action: "crm.account.imported",
          targetType: "crm_account",
          targetId: accountId,
          payload: { code, name, line: row.line },
        });
      }

      return summarize(analysis.rows);
    });

    revalidatePath("/crm/accounts");
    return {
      ok: true,
      message: `已导入 ${preview.summary.ok} 条客户`,
      preview,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
