import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { emptyState, pageWrap } from "@/components/knowledge/tokens";
import { requireSession } from "@/lib/auth/session";
import { buildCrmDictionaryOptions } from "@/lib/crm/dictionary";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { resolveContextPermissions } from "@/lib/permissions/server";

import { AccountDetailClient, type AccountDetail, type ContactRow, type DocumentRow, type HistoryEntry, type InteractionRow } from "./AccountDetailClient";

export const dynamic = "force-dynamic";

interface AccountQueryRow {
  id: string;
  code: string;
  name: string;
  company_name: string | null;
  region: string | null;
  country: string | null;
  address: string | null;
  email: string | null;
  website: string | null;
  fax: string | null;
  postal_code: string | null;
  sales_region: string | null;
  enterprise_type: string | null;
  brand: string | null;
  sales_channel: string | null;
  source: string | null;
  grade: string | null;
  customer_type: string | null;
  main_products: string | null;
  interested_products: string | null;
  competitors: string | null;
  annual_revenue: string | null;
  employee_count: string | null;
  founded_year: string | null;
  market_contact: string | null;
  purchase_frequency: string | null;
  required_quality: string | null;
  traffic_content: string | null;
  analysis: string | null;
  contact_status: string;
  deal_status: string;
  pool_status: string;
  owner_user_id: string | null;
  owner_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ContactQueryRow {
  id: string;
  name: string;
  job_title: string | null;
  role_type: string | null;
  mobile: string | null;
  phone: string | null;
  email: string | null;
  wechat: string | null;
  whatsapp: string | null;
  is_primary: boolean;
}

interface HistoryQueryRow {
  action: string;
  actor_name: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

interface InteractionQueryRow {
  id: string;
  purpose: string | null;
  direction: string;
  channel: string;
  occurred_at: Date;
  next_follow_at: Date | null;
  subject: string | null;
  content: string | null;
  status: string;
  is_opportunity: boolean;
  interested_products: string | null;
  category: string | null;
  contact_name: string | null;
}

interface DocumentQueryRow {
  id: string;
  name: string;
  mime: string | null;
  size_bytes: string | number;
  uploader_name: string | null;
  created_at: Date;
}

interface DictionaryQueryRow {
  dict_type: string;
  code: string;
  label: string;
}

export default async function CrmAccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有有效任用，无法查看客户。</div>
      </section>
    );
  }

  const data = await withUserContext(context, async (client) => {
    const permissions = await resolveContextPermissions(client, context);
    const accountResult = await client.query<AccountQueryRow>(
      `select a.*, u.name as owner_name
         from crm_accounts a
         left join users u on u.id = a.owner_user_id
        where a.id = $1
          and a.archived_at is null`,
      [id],
    );
    const account = accountResult.rows[0];
    if (!account) {
      return null;
    }

    const [contacts, history, mergeCandidates, interactions, documents, dictionaries] = await Promise.all([
      client.query<ContactQueryRow>(
        `select id, name, job_title, role_type, mobile, phone, email, wechat, whatsapp, is_primary
           from crm_contacts
          where account_id = $1
          order by is_primary desc, created_at asc`,
        [id],
      ),
      client.query<HistoryQueryRow>(
        `select e.action, u.name as actor_name, e.payload, e.created_at
           from audit_events e
           left join users u on u.id = e.actor_user_id
          where e.tenant_id = $1
            and e.target_type = 'crm_account'
            and e.target_id = $2
          order by e.created_at desc
          limit 50`,
        [context.tenantId, id],
      ),
      permissions.grants.has("crm:merge")
        ? client.query<{ id: string; code: string; name: string }>(
            `select id, code, name
               from crm_accounts
              where id <> $1
                and archived_at is null
                and merged_into_id is null
                and pool_status = 'private'
              order by updated_at desc
              limit 100`,
            [id],
          )
        : Promise.resolve({ rows: [] as { id: string; code: string; name: string }[] }),
      client.query<InteractionQueryRow>(
        `select i.id, i.purpose, i.direction, i.channel, i.occurred_at, i.next_follow_at,
                i.subject, i.content, i.status, i.is_opportunity, i.interested_products,
                i.category, c.name as contact_name
           from crm_interactions i
           left join crm_contacts c on c.id = i.contact_id
          where i.account_id = $1
          order by i.occurred_at desc
          limit 100`,
        [id],
      ),
      client.query<DocumentQueryRow>(
        `select d.id, d.name, d.mime, d.size_bytes, u.name as uploader_name, d.created_at
           from crm_documents d
           left join users u on u.id = d.uploaded_by
          where d.account_id = $1
          order by d.created_at desc`,
        [id],
      ),
      client.query<DictionaryQueryRow>(
        `select dict_type, code, label
           from trade_dictionaries
          where tenant_id = $1 and enabled
          order by dict_type, sort, code`,
        [context.tenantId],
      ),
    ]);

    const hasWrite = permissions.grants.has("crm:write");
    const canWriteRecord =
      hasWrite &&
      (context.accessLevel === "L1" ||
        context.accessLevel === "L2" ||
        account.owner_user_id === context.userId);

    return {
      account,
      contacts: contacts.rows,
      history: history.rows,
      canWrite: canWriteRecord,
      canMerge: permissions.grants.has("crm:merge"),
      mergeCandidates: mergeCandidates.rows,
      interactions: interactions.rows,
      documents: documents.rows,
      dictionaries: dictionaries.rows,
    };
  });

  if (!data) {
    notFound();
  }

  const account: AccountDetail = {
    id: data.account.id,
    code: data.account.code,
    name: data.account.name,
    companyName: data.account.company_name ?? "",
    region: data.account.region ?? "",
    country: data.account.country ?? "",
    address: data.account.address ?? "",
    email: data.account.email ?? "",
    website: data.account.website ?? "",
    fax: data.account.fax ?? "",
    postalCode: data.account.postal_code ?? "",
    salesRegion: data.account.sales_region ?? "",
    enterpriseType: data.account.enterprise_type ?? "",
    brand: data.account.brand ?? "",
    salesChannel: data.account.sales_channel ?? "",
    source: data.account.source ?? "",
    grade: data.account.grade ?? "",
    customerType: data.account.customer_type ?? "",
    mainProducts: data.account.main_products ?? "",
    interestedProducts: data.account.interested_products ?? "",
    competitors: data.account.competitors ?? "",
    annualRevenue: data.account.annual_revenue ?? "",
    employeeCount: data.account.employee_count ?? "",
    foundedYear: data.account.founded_year ?? "",
    marketContact: data.account.market_contact ?? "",
    purchaseFrequency: data.account.purchase_frequency ?? "",
    requiredQuality: data.account.required_quality ?? "",
    trafficContent: data.account.traffic_content ?? "",
    analysis: data.account.analysis ?? "",
    contactStatus: data.account.contact_status,
    dealStatus: data.account.deal_status,
    poolStatus: data.account.pool_status,
    ownerName: data.account.owner_name ?? "未分配",
    createdAt: data.account.created_at.toISOString(),
    updatedAt: data.account.updated_at.toISOString(),
  };

  const contacts: ContactRow[] = data.contacts.map((row) => ({
    id: row.id,
    name: row.name,
    jobTitle: row.job_title ?? "",
    roleType: row.role_type ?? "",
    mobile: row.mobile ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
    wechat: row.wechat ?? "",
    whatsapp: row.whatsapp ?? "",
    isPrimary: row.is_primary,
  }));

  const history: HistoryEntry[] = data.history.map((row) => ({
    action: row.action,
    actorName: row.actor_name ?? "系统",
    createdAt: row.created_at.toISOString(),
    payload: row.payload ?? {},
  }));

  const interactions: InteractionRow[] = data.interactions.map((row) => ({
    id: row.id,
    purpose: row.purpose ?? "",
    direction: row.direction,
    channel: row.channel,
    occurredAt: row.occurred_at.toISOString(),
    nextFollowAt: row.next_follow_at ? row.next_follow_at.toISOString() : null,
    subject: row.subject ?? "",
    content: row.content ?? "",
    status: row.status,
    isOpportunity: row.is_opportunity,
    interestedProducts: row.interested_products ?? "",
    category: row.category ?? "",
    contactName: row.contact_name ?? "",
  }));

  const documents: DocumentRow[] = data.documents.map((row) => ({
    id: row.id,
    name: row.name,
    mime: row.mime ?? "",
    sizeBytes: Number(row.size_bytes ?? 0),
    uploaderName: row.uploader_name ?? "—",
    createdAt: row.created_at.toISOString(),
  }));

  return (
    <AccountDetailClient
      account={account}
      contacts={contacts}
      history={history}
      interactions={interactions}
      documents={documents}
      dictOptions={buildCrmDictionaryOptions(data.dictionaries)}
      canWrite={data.canWrite}
      canMerge={data.canMerge}
      mergeCandidates={data.mergeCandidates}
    />
  );
}
