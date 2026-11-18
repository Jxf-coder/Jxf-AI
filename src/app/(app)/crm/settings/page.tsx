import { headers } from "next/headers";

import { emptyState, pageWrap } from "@/components/knowledge/tokens";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { resolveContextPermissions } from "@/lib/permissions/server";

import {
  CrmSettingsClient,
  type CodeRuleRow,
  type DictionaryItem,
  type HolderCapRow,
  type PolicyRow,
  type SettingsMember,
} from "./CrmSettingsClient";

export const dynamic = "force-dynamic";

const CODE_TYPES: { key: string; label: string; fallback: string }[] = [
  { key: "customer", label: "客户编号", fallback: "C" },
  { key: "quote", label: "报价编号", fallback: "Q" },
  { key: "contract", label: "合同编号", fallback: "CT" },
  { key: "sample", label: "寄样编号", fallback: "S" },
];

interface CodeRuleQueryRow {
  code_type: string;
  prefix: string;
}

interface DictionaryQueryRow {
  id: string;
  dict_type: string;
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
}

interface DepartmentQueryRow {
  id: string;
  name: string;
  can_write: boolean;
}

interface PolicyQueryRow {
  department_id: string;
  holder_cap: number;
  manager_holder_cap: number;
  key_grade_threshold: number;
  key_pending_ttl_days: number;
  claim_mode: string;
}

interface HolderCapQueryRow {
  user_id: string;
  user_name: string | null;
  holder_cap: number | null;
  reason: string | null;
  valid_until: Date | null;
}

interface MemberQueryRow {
  id: string;
  name: string | null;
  department_name: string;
}

export default async function CrmSettingsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有有效任用，无法查看设置。</div>
      </section>
    );
  }

  const data = await withUserContext(context, async (client) => {
    const permissions = await resolveContextPermissions(client, context);
    const canDict = permissions.grants.has("crm:dict_manage");
    const canPool = permissions.grants.has("crm:pool_policy");
    const canCap = permissions.grants.has("crm:holder_cap");
    if (!canDict && !canPool && !canCap) {
      return null;
    }

    const [dictionaries, departments, policies, caps, members, codeRules] = await Promise.all([
      canDict || canPool || canCap
        ? client.query<DictionaryQueryRow>(
            `select id, dict_type, code, label, sort, enabled
               from trade_dictionaries
              where tenant_id = $1
              order by dict_type, sort, code`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as DictionaryQueryRow[] }),
      canPool
        ? client.query<DepartmentQueryRow>(
            `select id, name, app.can_write(id) as can_write
               from departments
              where tenant_id = $1
              order by name`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as DepartmentQueryRow[] }),
      canPool
        ? client.query<PolicyQueryRow>(
            `select department_id, holder_cap, manager_holder_cap,
                    key_grade_threshold, key_pending_ttl_days, claim_mode
               from crm_pool_policies
              where tenant_id = $1`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as PolicyQueryRow[] }),
      canCap
        ? client.query<HolderCapQueryRow>(
            `select c.user_id, u.name as user_name, c.holder_cap, c.reason, c.valid_until
               from crm_holder_caps c
               left join users u on u.id = c.user_id
              where c.tenant_id = $1
              order by u.name nulls last`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as HolderCapQueryRow[] }),
      canCap
        ? client.query<MemberQueryRow>(
            `select u.id, u.name, d.name as department_name
               from memberships m
               join users u on u.id = m.user_id
               join departments d on d.id = m.department_id
              where m.tenant_id = $1
                and m.status = 'active'
                and u.status = 'active'
              order by d.name, u.name nulls last`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as MemberQueryRow[] }),
      canDict
        ? client.query<CodeRuleQueryRow>(
            `select code_type, prefix
               from trade_code_rules
              where tenant_id = $1`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as CodeRuleQueryRow[] }),
    ]);

    return {
      canDict,
      canPool,
      canCap,
      isL1: context.accessLevel === "L1",
      dictionaries: dictionaries.rows,
      departments: departments.rows,
      policies: policies.rows,
      caps: caps.rows,
      members: members.rows,
      codeRules: codeRules.rows,
    };
  });

  if (!data) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有 CRM 配置权限，请联系 L1 老板授权。</div>
      </section>
    );
  }

  const dictionaries: DictionaryItem[] = data.dictionaries.map((row) => ({
    id: row.id,
    dictType: row.dict_type,
    code: row.code,
    label: row.label,
    sort: row.sort,
    enabled: row.enabled,
  }));

  const policyByDepartment = new Map(data.policies.map((row) => [row.department_id, row]));
  const policies: PolicyRow[] = data.departments.map((department) => {
    const policy = policyByDepartment.get(department.id);
    return {
      departmentId: department.id,
      departmentName: department.name,
      holderCap: policy?.holder_cap ?? 150,
      managerHolderCap: policy?.manager_holder_cap ?? 500,
      keyGradeThreshold: policy?.key_grade_threshold ?? 80,
      keyPendingTtlDays: policy?.key_pending_ttl_days ?? 7,
      claimMode: policy?.claim_mode ?? "self",
      configured: Boolean(policy),
      canWrite: department.can_write,
    };
  });

  const caps: HolderCapRow[] = data.caps.map((row) => ({
    userId: row.user_id,
    userName: row.user_name?.trim() || "未命名成员",
    holderCap: row.holder_cap,
    reason: row.reason ?? "",
    validUntil: row.valid_until ? row.valid_until.toISOString() : null,
  }));

  const members: SettingsMember[] = data.members.map((row) => ({
    id: row.id,
    name: row.name?.trim() || "未命名成员",
    departmentName: row.department_name,
  }));

  const dictTypes = [...new Set(dictionaries.map((item) => item.dictType))].sort();

  const ruleByType = new Map(data.codeRules.map((row) => [row.code_type, row.prefix]));
  const codeRules: CodeRuleRow[] = CODE_TYPES.map((type) => ({
    codeType: type.key,
    label: type.label,
    prefix: ruleByType.get(type.key) ?? type.fallback,
    configured: ruleByType.has(type.key),
  }));

  return (
    <CrmSettingsClient
      dictionaries={dictionaries}
      policies={policies}
      caps={caps}
      members={members}
      dictTypes={dictTypes}
      codeRules={codeRules}
      canDict={data.canDict}
      canPool={data.canPool}
      canCap={data.canCap}
      isL1={data.isL1}
    />
  );
}
