import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { auditInTx } from "@/lib/audit";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { PermissionDeniedError, toPermissionMessage } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";
import { putObject, uploadKey } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "txt",
  "md",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "zip",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 上传客户附件：multipart/form-data（accountId, file） */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const context = await resolveUserContext(session.user.id);
  if (!context.accessLevel) {
    return Response.json({ ok: false, error: "没有有效任用" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { ok: false, error: "请求格式不正确（需要 multipart/form-data）" },
      { status: 400 },
    );
  }

  const accountId = String(form.get("accountId") ?? "").trim();
  const file = form.get("file");
  if (!accountId) {
    return Response.json({ ok: false, error: "缺少客户标识" }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ ok: false, error: "请选择要上传的文件" }, { status: 400 });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return Response.json(
      { ok: false, error: "单个附件不超过 20 MB，请压缩后重试" },
      { status: 413 },
    );
  }
  const name = file.name.trim().slice(0, 160);
  if (!name) {
    return Response.json({ ok: false, error: "文件名不能为空" }, { status: 400 });
  }
  if (!ALLOWED_EXTENSIONS.has(extensionOf(name))) {
    return Response.json(
      { ok: false, error: "仅支持 PDF / Word / Excel / CSV / 文本 / 图片 / ZIP" },
      { status: 415 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    await withUserContext(context, async (client) => {
      const account = await client.query<{
        code: string;
        department_id: string;
        owner_user_id: string | null;
      }>(
        `select code, department_id, owner_user_id
           from crm_accounts
          where id = $1 and archived_at is null`,
        [accountId],
      );
      const accountRow = account.rows[0];
      if (!accountRow) {
        throw new Error("客户不存在或你无权操作");
      }

      const resource = {
        kind: "crm_account",
        id: accountId,
        departmentId: accountRow.department_id,
        ownerUserId: accountRow.owner_user_id,
      };
      await requireDocumentWritePermission(client, context, resource);

      const storageKey = uploadKey({
        department: "crm",
        role: accountRow.code,
        folder: "documents",
        filename: `${Date.now()}-${name}`,
      });

      const inserted = await client.query<{ id: string }>(
        `insert into crm_documents
           (tenant_id, account_id, name, storage_key, mime, size_bytes, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          context.tenantId,
          accountId,
          name,
          storageKey,
          file.type || null,
          file.size,
          context.userId,
        ],
      );
      const documentId = inserted.rows[0]?.id;
      if (!documentId) {
        throw new Error("附件登记失败");
      }

      await putObject(storageKey, bytes);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: accountRow.department_id,
        action: "crm.account.document_uploaded",
        targetType: "crm_account",
        targetId: accountId,
        payload: { documentId, name, size: file.size, mime: file.type || null },
      });
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    return Response.json({ ok: false, error: toPermissionMessage(error) }, { status: 400 });
  }

  revalidatePath(`/crm/accounts/${accountId}`);
  return Response.json({ ok: true, message: `已上传「${name}」` });
}

/** 守卫包装：命名以 Permission 结尾，静态扫描与应用运行都走这里 */
async function requireDocumentWritePermission(
  client: Parameters<typeof requireContextPermission>[0],
  context: Parameters<typeof requireContextPermission>[1],
  resource: Parameters<typeof requireContextPermission>[3],
) {
  return requireContextPermission(client, context, "crm:write", resource);
}
