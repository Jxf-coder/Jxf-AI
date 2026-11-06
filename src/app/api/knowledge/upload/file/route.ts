import { auth } from "@/auth";
import { resolveUserContext } from "@/lib/db/user-context";
import { isFolderKey } from "@/lib/knowledge/folders";
import { ingestUpload, MAX_FILE_BYTES } from "@/lib/knowledge/ingest";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 逐文件入库：multipart/form-data（file, runId?, goal?, path?, folder?）。
 * 带 runId 时追加到同一批次；不带则新建一个批次并返回 runId。
 * folder 为 10 个标准目录的 key，落盘路径与数据库 key 都由服务端拼装。
 * 单文件同步解析，前端按顺序调用即可拿到逐文件进度。
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

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ ok: false, error: "没有收到文件" }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ ok: false, error: "文件为空" }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ ok: false, error: `${file.name} 超过 20MB 上限` }, { status: 413 });
  }

  const runId = String(form.get("runId") ?? "").trim() || undefined;
  const goal = String(form.get("goal") ?? "");
  const relativePath = String(form.get("path") ?? "").trim() || file.name;
  const folder = String(form.get("folder") ?? "").trim();

  try {
    const result = await ingestUpload(
      context,
      [
        {
          name: relativePath,
          mime: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
      ],
      goal,
      { runId, folderKey: isFolderKey(folder) ? folder : undefined },
    );

    return Response.json({
      ok: true,
      runId: result.runId,
      counts: result.counts,
      file: result.files[0] ?? null,
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    log("error", "knowledge_upload_one_failed", {
      user_id: context.userId,
      department_id: context.activeDepartmentId,
      file: relativePath,
      run_id: runId ?? null,
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: errorMessage(error), runId: runId ?? null }, { status: 500 });
  }
}
