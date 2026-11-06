import { auth } from "@/auth";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { getObject } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 原始文件下载：服务端转发 MinIO，同样经过 RLS 与部门可见性校验。
 * 越权 / 不存在的文档统一返回 404，避免泄露存在性。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("未登录", { status: 401 });
  }

  const { id } = await params;
  const context = await resolveUserContext(session.user.id);

  try {
    const target = await withUserContext(context, async (client) => {
      const { rows } = await client.query<{ title: string; mime: string; storage_key: string | null }>(
        `select d.title, d.mime, a.storage_key
           from documents d
           left join assets a on a.id = d.asset_id
          where d.id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });

    if (!target?.storage_key) {
      return new Response("文档不存在", { status: 404 });
    }

    const object = await getObject(target.storage_key);
    return new Response(Buffer.from(object.body), {
      headers: {
        "content-type": target.mime || object.contentType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(target.title)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    log("warn", "knowledge_download_failed", { document_id: id, error: errorMessage(error) });
    return new Response("文档不存在", { status: 404 });
  }
}
