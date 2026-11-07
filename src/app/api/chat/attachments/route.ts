import { auth } from "@/auth";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { parseDocument, UnsupportedDocumentError } from "@/lib/knowledge/parse";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 单个附件进入提示词的字符上限；超出部分截断并如实告知前端 */
const MAX_TEXT_CHARS = 12_000;

/**
 * Agent 附件解析：接收 multipart/form-data（file），返回可直接拼进提示词的纯文本。
 *
 * 只做解析，不落盘、不入库：附件属于本轮对话上下文，随 run 的 input 一起快照。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const context = await resolveUserContext(session.user.id);
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    return Response.json({ ok: false, error: "当前账号没有有效部门上下文" }, { status: 400 });
  }

  try {
    await withUserContext(context, (client) =>
      requireContextPermission(client, context, "skill:use", {
        kind: "department",
        id: departmentId,
        departmentId,
      }),
    );
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return Response.json({ ok: false, error: error.message }, { status: 403 });
    }
    return Response.json({ ok: false, error: "附件解析鉴权失败" }, { status: 500 });
  }

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
    return Response.json({ ok: false, error: `${file.name} 超过 10MB 上限` }, { status: 413 });
  }

  try {
    const parsed = await parseDocument(
      new Uint8Array(await file.arrayBuffer()),
      file.type,
      file.name,
    );
    if (!parsed.hasText) {
      return Response.json(
        { ok: false, error: `${file.name} 未解析出文字（可能是扫描件或图片）` },
        { status: 422 },
      );
    }

    const fullText = parsed.pages.join("\n\n").trim();
    const text = fullText.slice(0, MAX_TEXT_CHARS);
    return Response.json({
      ok: true,
      name: file.name,
      text,
      chars: text.length,
      truncated: fullText.length > text.length,
    });
  } catch (error) {
    if (error instanceof UnsupportedDocumentError) {
      return Response.json(
        { ok: false, error: `${file.name} 的格式暂不支持，请上传 PDF / DOCX / 文本文件` },
        { status: 415 },
      );
    }
    log("error", "chat_attachment_parse_failed", {
      user_id: context.userId,
      department_id: departmentId,
      file: file.name,
      error: errorMessage(error),
    });
    return Response.json({ ok: false, error: `${file.name} 解析失败` }, { status: 500 });
  }
}
