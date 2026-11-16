/**
 * 存量目录回填：把「02-知识卡片」里其实属于经验的卡找出来，先 dry-run 出清单，人工确认后再 --apply。
 *
 * 运行：npm run backfill:experience-folders [-- --apply --tenant=<uuid> --limit=2000 --show=50]
 * - 只扫描 folder_key = '02-cards' 且 status in ('pending','confirmed') 的卡，人工已移到别处的不动；
 * - 复用 routeFolder 的语义路由，只挑建议落到 05-distill / 08-retro 且不是规则冲突的；
 * - --apply 只改目录相关字段（folder_key / suggested_folder / route_reason / route_confidence /
 *   route_pending）并推进 rev，不改正文、状态与证据；每张卡写一条审计；
 * - 默认 dry-run，不写入任何数据；可重复执行，已被移动的卡不会再次出现。
 */
import { Client } from "pg";

import { routeFolder } from "../src/lib/knowledge/experience/routing.ts";

const EXPERIENCE_FOLDERS = new Set(["05-distill", "08-retro"]);

const argv = process.argv.slice(2);
const flag = (name) => argv.find((item) => item === `--${name}` || item.startsWith(`--${name}=`));
const valueOf = (name, fallback) => {
  const hit = flag(name);
  if (!hit || !hit.includes("=")) {
    return fallback;
  }
  const parsed = Number.parseInt(hit.split("=")[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const APPLY = Boolean(flag("apply"));
const LIMIT = valueOf("limit", 2000);
const SHOW = valueOf("show", 50);
const TENANT = flag("tenant")?.split("=")[1] ?? process.env.JXF_TENANT_ID;

if (!TENANT) {
  console.error("[FAIL] 缺少租户：请设置 JXF_TENANT_ID 或传 --tenant=<uuid>");
  process.exit(2);
}

const host = process.env.SEED_DB_HOST ?? "127.0.0.1";
const port = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const url = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${host}:${port}/${process.env.POSTGRES_DB}`;

const client = new Client({ connectionString: url, application_name: "jxf-backfill-experience-folders" });
await client.connect();

try {
  const { rows: cards } = await client.query(
    `select id, department_id, kind, title, body, status, folder_key,
            source_channel, route_reason
       from knowledge_cards
      where tenant_id = $1
        and folder_key = '02-cards'
        and status in ('pending', 'confirmed')
      order by created_at, id
      limit $2`,
    [TENANT, LIMIT],
  );

  const candidates = [];
  const conflicts = [];
  for (const card of cards) {
    const route = routeFolder({
      channel: card.source_channel ?? "document",
      kind: card.kind,
      title: card.title,
      body: card.body,
    });
    const target = route.suggestedFolder ?? route.folderKey;
    if (route.pending || !EXPERIENCE_FOLDERS.has(target)) {
      if (route.pending) {
        conflicts.push({ card, route });
      }
      continue;
    }
    candidates.push({ card, route, target });
  }

  const byTarget = candidates.reduce((acc, item) => {
    acc[item.target] = (acc[item.target] ?? 0) + 1;
    return acc;
  }, {});
  const byReason = candidates.reduce((acc, item) => {
    acc[item.route.reason] = (acc[item.route.reason] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `[开始] tenant=${TENANT} 扫描 ${cards.length} 张 02 卡 · 经验候选 ${candidates.length} 张 · 规则冲突 ${conflicts.length} 张${APPLY ? "" : " · dry-run"}`,
  );
  if (candidates.length > 0) {
    console.log(`[目标目录] ${JSON.stringify(byTarget)}`);
    console.log(`[命中原因] ${JSON.stringify(byReason)}`);
  }
  for (const item of candidates.slice(0, SHOW)) {
    console.log(
      `  - ${item.card.id} [${item.card.status}] ${item.card.title} → ${item.target}（${item.route.reason}，${item.route.confidence}）`,
    );
  }
  if (candidates.length > SHOW) {
    console.log(`  … 其余 ${candidates.length - SHOW} 张未展开（--show=<n> 可调整）`);
  }
  for (const item of conflicts.slice(0, 10)) {
    console.log(`  ! 冲突待裁决 ${item.card.id} ${item.card.title}：${item.route.reason}`);
  }

  if (!APPLY) {
    console.log("[结束] dry-run：未写入任何数据；确认清单后加 --apply 再执行");
    process.exit(0);
  }

  let updated = 0;
  await client.query("begin");
  try {
    for (const item of candidates) {
      const result = await client.query(
        `update knowledge_cards
            set folder_key = $3, suggested_folder = $3, route_reason = $4,
                route_confidence = $5, route_pending = false,
                rev = rev + 1, updated_at = now()
          where id = $1 and tenant_id = $2 and folder_key = '02-cards'`,
        [item.card.id, TENANT, item.target, item.route.reason, item.route.confidence],
      );
      if ((result.rowCount ?? 0) === 0) {
        continue;
      }
      updated += 1;
      await client.query(
        `insert into audit_events
           (tenant_id, actor_user_id, department_id, action, target_type, target_id, payload)
         values ($1, null, $2, 'knowledge.card_folder_backfilled', 'knowledge_card', $3, $4::jsonb)`,
        [
          TENANT,
          item.card.department_id,
          item.card.id,
          JSON.stringify({
            from: "02-cards",
            to: item.target,
            reason: item.route.reason,
            confidence: item.route.confidence,
            script: "backfill-experience-folders",
          }),
        ],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }

  console.log(`[完成] 回填 ${updated}/${candidates.length} 张卡到经验目录`);
  process.exit(0);
} finally {
  await client.end().catch(() => {});
}
