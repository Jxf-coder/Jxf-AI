"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { toPermissionMessage } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";
import { deleteObject } from "@/lib/storage/local";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/** 删除客户附件：先删库记录，提交后再清理磁盘文件 */
export async function deleteAccountDocument(input: {
  accountId: string;
  documentId: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const accountId = String(input.accountId ?? "").trim();
    const documentId = String(input.documentId ?? "").trim();
    if (!accountId || !documentId) {
      throw new Error("缺少附件标识");
    }

    const storageKey = await withUserContext(context, async (client) => {
      const document = await client.query<{
        name: string;
        storage_key: string;
        department_id: string;
        owner_user_id: string | null;
      }>(
        `select d.name, d.storage_key, a.department_id, a.owner_user_id
           from crm_documents d
           join crm_accounts a on a.id = d.account_id
          where d.id = $1 and d.account_id = $2`,
        [documentId, accountId],
      );
      const row = document.rows[0];
      if (!row) {
        throw new Error("附件不存在或你无权删除");
      }

      await requireContextPermission(client, context, "crm:write", {
        kind: "crm_account",
        id: accountId,
        departmentId: row.department_id,
        ownerUserId: row.owner_user_id,
      });

      const removed = await client.query(
        "delete from crm_documents where id = $1 and tenant_id = $2",
        [documentId, context.tenantId],
      );
      if (removed.rowCount === 0) {
        throw new Error("附件不存在或你无权删除");
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: row.department_id,
        action: "crm.account.document_deleted",
        targetType: "crm_account",
        targetId: accountId,
        payload: { documentId, name: row.name },
      });

      return row.storage_key;
    });

    await deleteObject(storageKey);

    revalidatePath(`/crm/accounts/${accountId}`);
    return { ok: true, message: "附件已删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
