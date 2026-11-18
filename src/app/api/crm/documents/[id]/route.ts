import { auth } from "@/auth";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { getObject } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
]);

/** 下载 / 预览客户附件：权限完全跟随 crm_documents 的 RLS */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const context = await resolveUserContext(session.user.id);
  if (!context.accessLevel) {
    return Response.json({ ok: false, error: "没有有效任用" }, { status: 403 });
  }

  const document = await withUserContext(context, async (client) => {
    const result = await client.query<{ name: string; storage_key: string; mime: string | null }>(
      "select name, storage_key, mime from crm_documents where id = $1",
      [id],
    );
    return result.rows[0] ?? null;
  });

  if (!document) {
    return Response.json({ ok: false, error: "附件不存在或你无权查看" }, { status: 404 });
  }

  let object: { body: Uint8Array; contentType: string };
  try {
    object = await getObject(document.storage_key);
  } catch {
    return Response.json({ ok: false, error: "附件文件缺失，请联系管理员" }, { status: 410 });
  }

  const mime = document.mime || object.contentType;
  const inline = INLINE_MIME.has(mime);
  const encoded = encodeURIComponent(document.name);
  const copy = new Uint8Array(object.body.byteLength);
  copy.set(object.body);

  return new Response(new Blob([copy.buffer], { type: mime }), {
    headers: {
      "content-type": mime,
      "content-length": String(object.body.byteLength),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="document"; filename*=UTF-8''${encoded}`,
      "cache-control": "private, no-store",
    },
  });
}
