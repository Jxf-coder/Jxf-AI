/**
 * 99-回收站：文档软删 / 还原、卡片作废后还原、彻底删除与清空。
 *
 * 红线：
 * - 全部在 withUserContext（jxf_app + RLS）内执行，写范围只由 app.can_write 决定；
 * - 彻底删除只对「回收站内」的行生效（文档 deleted_at 非空 / 卡片 status = dropped）；
 * - 磁盘清理由事务提交后执行，失败只记日志，不回滚数据库删除。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";
import { deleteObject } from "@/lib/storage/local";

interface DocumentRow {
  department_id: string;
  deleted_at: Date | null;
  asset_id: string | null;
}

/** 软删进 99-回收站：只置 deleted_at，切片与原文件保留，可随时恢复 */
export async function trashDocument(context: UserContext, documentId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<DocumentRow>(
      `select department_id, deleted_at, asset_id from documents where id = $1`,
      [documentId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("文档不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (row.deleted_at) {
      return;
    }

    await client.query(
      `update documents set deleted_at = now(), deleted_by = $2 where id = $1 and department_id = $3`,
      [documentId, context.userId, row.department_id],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.document_trashed",
      targetType: "document",
      targetId: documentId,
      departmentId: row.department_id,
    });
  });
}

/** 从 99-回收站恢复：回到原岗位与目录（role_key / folder_key 从未改动） */
export async function restoreDocument(context: UserContext, documentId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<DocumentRow>(
      `select department_id, deleted_at, asset_id from documents where id = $1`,
      [documentId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("文档不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (!row.deleted_at) {
      return;
    }

    await client.query(
      `update documents set deleted_at = null, deleted_by = null where id = $1 and department_id = $2`,
      [documentId, row.department_id],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.document_restored",
      targetType: "document",
      targetId: documentId,
      departmentId: row.department_id,
    });
  });
}

/** 作废卡恢复为待确认：不改变正文与证据，只回到可编辑、可确认状态 */
export async function restoreCard(context: UserContext, cardId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string; status: string }>(
      `select department_id, status from knowledge_cards where id = $1`,
      [cardId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("知识卡不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (row.status !== "dropped") {
      return;
    }

    await client.query(
      `update knowledge_cards
          set status = 'pending', rev = rev + 1, updated_at = now()
        where id = $1 and department_id = $2 and status = 'dropped'`,
      [cardId, row.department_id],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_restored",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId: row.department_id,
    });
  });
}

/** 彻底删除一份回收站内的文档：连带资产与磁盘原件（不再被其他文档引用时） */
export async function purgeDocument(context: UserContext, documentId: string): Promise<void> {
  const outcome = await withUserContext(context, async (client) => {
    const { rows } = await client.query<DocumentRow>(
      `select department_id, deleted_at, asset_id from documents where id = $1`,
      [documentId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("文档不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (!row.deleted_at) {
      throw new Error("只有回收站中的文档可以彻底删除");
    }

    let storageKey: string | null = null;
    if (row.asset_id) {
      const asset = await client.query<{ storage_key: string }>(
        `select a.storage_key
           from assets a
          where a.id = $1
            and not exists (
              select 1 from documents d2 where d2.asset_id = a.id and d2.id <> $2
            )`,
        [row.asset_id, documentId],
      );
      storageKey = asset.rows[0]?.storage_key ?? null;
    }

    await client.query(`delete from documents where id = $1 and department_id = $2`, [
      documentId,
      row.department_id,
    ]);

    if (storageKey) {
      await client.query(`delete from assets where id = $1`, [row.asset_id]);
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.document_purged",
      targetType: "document",
      targetId: documentId,
      departmentId: row.department_id,
    });

    return { storageKey };
  });

  if (outcome.storageKey) {
    try {
      await deleteObject(outcome.storageKey);
    } catch (error) {
      log("warn", "storage_delete_failed", {
        key: outcome.storageKey,
        error: errorMessage(error),
      });
    }
  }
}

/** 彻底删除一张已作废的卡片（证据级联删除） */
export async function purgeCard(context: UserContext, cardId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string; status: string }>(
      `select department_id, status from knowledge_cards where id = $1`,
      [cardId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("知识卡不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (row.status !== "dropped") {
      throw new Error("只有已作废的知识卡可以彻底删除");
    }

    await client.query(`delete from knowledge_cards where id = $1 and department_id = $2`, [
      cardId,
      row.department_id,
    ]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_purged",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId: row.department_id,
    });
  });
}

export interface EmptyTrashResult {
  documents: number;
  cards: number;
}

/** 清空某部门的回收站：文档 + 作废卡一并物理删除，原件随后落盘清理 */
export async function emptyTrash(
  context: UserContext,
  departmentId: string,
): Promise<EmptyTrashResult> {
  const outcome = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const assets = await client.query<{ id: string; storage_key: string }>(
      `select a.id, a.storage_key
         from assets a
        where exists (
                select 1 from documents d
                 where d.asset_id = a.id and d.department_id = $1 and d.deleted_at is not null
              )
          and not exists (
                select 1 from documents d2
                 where d2.asset_id = a.id and d2.deleted_at is null
              )`,
      [departmentId],
    );

    const documents = await client.query(
      `delete from documents where department_id = $1 and deleted_at is not null`,
      [departmentId],
    );
    const cards = await client.query(
      `delete from knowledge_cards where department_id = $1 and status = 'dropped'`,
      [departmentId],
    );

    for (const asset of assets.rows) {
      await client.query(`delete from assets where id = $1`, [asset.id]);
    }

    const result = {
      documents: documents.rowCount ?? 0,
      cards: cards.rowCount ?? 0,
      storageKeys: assets.rows.map((asset) => asset.storage_key),
    };

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.trash_emptied",
      targetType: "department",
      targetId: departmentId,
      departmentId,
      payload: { documents: result.documents, cards: result.cards },
    });

    return result;
  });

  for (const key of outcome.storageKeys) {
    try {
      await deleteObject(key);
    } catch (error) {
      log("warn", "storage_delete_failed", { key, error: errorMessage(error) });
    }
  }

  return { documents: outcome.documents, cards: outcome.cards };
}
