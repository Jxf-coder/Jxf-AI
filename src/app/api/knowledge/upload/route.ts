import { auth } from "@/auth";
import { resolveUserContext } from "@/lib/db/user-context";
import { ingestUpload, MAX_FILE_BYTES, type IngestFileInput } from "@/lib/knowledge/ingest";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { errorMessage, log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 文档入库：multipart/form-data（files[]，goal）。
 * 服务端解析 + 分块 + 向量化后落库，返回每个文件的处置结论。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const context = await resolveUserContext(session.user.id);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "请求格式不正确（需要 multipart/form-data）" }, { status: 400 });
  }

  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return Response.json({ ok: false, error: "没有收到文件" }, { status: 400 });
  }

  const inputs: IngestFileInput[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      return Response.json({ ok: false, error: `${file.name} 超过 20MB 上限` }, { status: 413 });
    }
    inputs.push({
      name: file.name,
      mime: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }

  try {
    const result = await ingestUpload(context, inputs, String(form.get("goal") ?? ""));
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    log("error", "knowledge_upload_failed", {
      user_id: context.userId,
      department_id: context.activeDepartmentId,
      files: inputs.map((input) => input.name),
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}
