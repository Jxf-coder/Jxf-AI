# 知识库轻量纯 UI 无损重构方案（V4 · 锁定版）

> 目标：把 `/knowledge` 重构成与原项目**同一套信息架构与交互**的知识沉淀页，但**零数据库迁移、零后台任务**，视觉统一走全站苹果令牌
> 前提：Tailwind CSS 3.4 已接入，`apple-*` 令牌已全站生效
> 状态：**方案已锁定**，本文件为实施基线；Step 0 / Step 1 已开始执行
> 锁定日期：2026-11-05

---

## 1. 锁定范围

### 1.1 做（6 个核心 Tab + 统计条）

| # | Tab | 内容 | 数据来源 |
|---|---|---|---|
| 0 | 统计条（常驻） | 知识单元 / 待确认 / 冲突·过期 / 缺口 / 问答（有引用÷总数）/ 回归通过率 | 新增只读聚合 `stats.ts` |
| 1 | 知识卡 | 状态胶囊、只看有问题的、类型/分类/产品筛选、搜索、批量条、徽章、证据折叠、行内编辑、手写卡、单卡操作 | `listCards`（扩筛选）+ 新服务 |
| 2 | 巡读上传 | 目标/标签/上限、拖拽区、`webkitdirectory`、逐文件进度、批次列表与详情、文件判定明细、整批撤回 | `ingest_runs` / `ingest_files` + 单文件端点 |
| 3 | 条目四字段 | 卡片元数据补全（来源 / 版本 / 负责人 / 有效期）、「只看没填齐的」 | `knowledge_cards.extra` |
| 4 | 缺口 | 手动记一条、已补 / 重开、状态点、时间 | `knowledge_gaps`（仅 status 流转） |
| 5 | 问答来源 | 命中点、问题、时间、来源编号、越界/未核数字徽章、答案摘要 | `qa_logs` |
| 6 | 回归题 | 加题 / 删题 / 重跑、单题命中与保留率、最近运行 | `regression_*` |

### 1.2 不做（明确砍掉）

| 模块 | 原因 |
|---|---|
| NAS / 服务器目录 / 定时巡读 | 需要后台执行体与凭据托管，属 M3 |
| 开工前问答（intake，17 字段） | 无对应模型，会引入新表 |
| 来源配置（群晖 / TrueNAS） | 需密钥加密存储 |
| 交接导出包 | 依赖原项目全套资产 |
| `0011` / `0012` 及任何 SQL 迁移 | **本次绝不改数据库结构** |
| `data-kb="classic"` 与 `#2543ff` 电光蓝 | 视觉统一走苹果蓝 `#0071e3` |
| 深色主题 | 全站未启用 |

### 1.3 卡片元数据的落法（不改表）

`source / version / owner` 全部写进已有列 `knowledge_cards.extra`：

```jsonc
extra = { "source": "《供应商手册 v2》P12", "version": "v2", "owner": "王工" }
```

- 写入：服务端合并 `extra`（`extra = extra || $2::jsonb`），同时 `rev = rev + 1` + 审计
- 读取：`extra->>'source'` 等；`extra` 已有 GIN 索引（`knowledge_cards_extra_gin_idx`）
- 筛选：在 SQL 里用 `coalesce(extra->>'owner','') = ''` 表达「四字段没填齐」

---

## 2. 视觉与令牌

### 2.1 全站统一 Apple 令牌（无作用域覆盖）

| 用途 | Tailwind | 值 |
|---|---|---|
| 主色 / 激活 | `apple-blue` / `apple-blue-soft` | `#0071e3` / `#eff4ff` |
| 主文字 / 次文字 | `apple-ink` / `apple-muted` | `#1d1d1f` / `#86868b` |
| 画布 / 二级底 | `bg-white` / `apple-canvas` | `#ffffff` / `#f7f8fa` |
| 描边 | `border-hairline` | `rgba(0,0,0,.04)` |
| 卡片阴影 | `shadow-card` | `0 1px 2px rgba(0,0,0,.03), 0 16px 40px -24px rgba(0,0,0,.18)` |

### 2.2 Step 0 补齐的「别名变量」

原项目组件用 `text-[var(--muted)]`、`bg-[var(--chip)]` 这类写法。为了让原 JSX **零改动搬入**，在 `:root` 增加别名（值指向苹果令牌，不是原项目色值）：

```css
:root {
  --ink: var(--text);              /* #1d1d1f */
  --muted: var(--text-secondary);  /* #6e6e73 */
  --line: var(--separator);        /* rgba(0,0,0,.04) */
  --chip: var(--sidebar-bg);       /* #f7f8fa */
  --on-ink: #ffffff;
  --btn-hover: #f0f1f4;
  --accent: var(--brand-500);      /* #0071e3 */
}
```

### 2.3 Step 0 补齐的「兼容组件类」

原项目只依赖 3 个组件类，用 `@apply` 映射到苹果令牌：

```css
@layer components {
  .lx-card { @apply rounded-2xl border border-hairline bg-white p-4 shadow-card; }
  .lx-btn { @apply inline-flex items-center justify-center rounded-xl px-3 py-1.5 text-[13px] font-medium transition-all duration-200 active:scale-[0.98]; }
  .lx-btn-primary { @apply bg-apple-blue text-white hover:bg-apple-blue-hover; }
  .lx-btn-ghost { @apply bg-apple-canvas text-zinc-800 hover:bg-[#eef0f4]; }
  .lx-input { @apply w-full rounded-xl border-0 bg-apple-canvas px-3 py-1.5 text-[13px] text-zinc-900 outline-none transition-all placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-apple-blue/20; }
}
```

> 命名沿用 `lx-*` 只为「复制原组件时不必改 class」；实现是纯苹果风，不含原项目任何色值。

---

## 3. 页面架构

### 3.1 Tab 用 URL 承载

```text
/knowledge?tab=cards&status=pending&kind=fact&category=包材&q=迁移量
/knowledge?tab=scout&run=<runId>
/knowledge?tab=meta | gaps | qa | regression
```

- 刷新 / 分享不丢状态；Server Component 按 tab 取数
- `/knowledge/cards` → `redirect("/knowledge?tab=cards")`
- 每次切换 Tab 只取当前 Tab 需要的查询，统计条常驻

### 3.2 目录结构

```text
src/components/knowledge/          # Step 1 基元库（纯展示）
├── tokens.ts                      # 类名令牌（由 app 内 ui.ts 迁出）
├── SectionCard.tsx
├── StatTile.tsx
├── Pill.tsx
├── Field.tsx
├── EvidenceList.tsx
├── EmptyState.tsx
└── InlineMessage.tsx

src/app/(app)/knowledge/
├── page.tsx                       # 壳：searchParams → StatBar + TabNav + 分发
├── _components/                   # 各 Tab（Step 2 起）
└── actions.ts / cards/actions.ts  # 既有 server actions
```

### 3.3 服务能力（全部零迁移）

| 文件 | 变更 |
|---|---|
| `src/lib/knowledge/stats.ts` | 新增：6 格统计 + `byCategory`（`withUserContext`） |
| `src/lib/knowledge/cards.ts` | `listCards` 扩筛选；新增 `bulkDecideCards` / `patchCards`（逐卡校验） |
| `src/lib/knowledge/gaps.ts` | 新增：`addGap` / `closeGap` / `reopenGap`（仅 status） |
| `src/lib/knowledge/qa.ts` | 新增只读 `listQaLogs`（不改 `answerQuestion`） |
| `src/lib/knowledge/regression.ts` | 新增 `addQuestion` / `removeQuestion` / `lastRunDetail` |
| `src/app/api/knowledge/upload/file/route.ts` | 新增：单文件 + runId 复用 |

统计指标口径（全部可由现有表算出）：

| 指标 | 口径 |
|---|---|
| 知识单元 | `documents(status='parsed')` + `knowledge_cards(status='confirmed')` |
| 待确认 | `knowledge_cards(status='pending')` |
| 冲突 / 过期 | `conflict_with <> '{}'` / `valid_until < current_date` |
| 缺口 | `knowledge_gaps(status='open')` |
| 顾问问答 | `qa_logs` 总数与 `cited_card_ids <> '{}'` 数 |
| 回归 | 最近一次 `regression_runs` 的 `passed/total` 与 `retained` |

---

## 4. Roadmap

> 每步一个本地 commit；每步跑四道闸门；视觉按 1330px / 390px 双尺寸验收。

| 步 | 内容 | 验收 |
|---|---|---|
| **0** | 别名变量 + `.lx-*` 兼容类 + 基线记录（基线 commit `86479a2`） | 现有页面零变化；闸门绿 |
| **1** | UI 基元库（7 个）+ 现有两页改用基元 | 像素与 Step 0 一致；闸门绿 |
| **2** | 单页壳 + `?tab=` + 统计条 + `stats.ts` | 6 格数字与手查 SQL 一致；刷新保留 tab |
| **3** | 知识卡 Tab 全量交互 | 混合批量返回 `passed/failed`；筛选组合正确 |
| **4** | 巡读上传 Tab（单文件端点 + 进度 + 批次详情） | 25 文件并发 3 落同一 run；重复 sha256 跳过 |
| **5** | 缺口 / 问答来源 / 回归题 / 四字段（extra） | 状态流转、元数据持久化、筛选正确 |
| **6** | 收口：390px、键盘可达、逐屏对照 | 四道闸门 + 视觉清单 |

---

## 5. 门禁与断言

**四道闸门**：`typecheck` → `build` → `test:rls`(33/33) → `test:knowledge`(52/52)。

**新增断言（只追加）**：

1. 统计聚合不含兄弟部门（L3 视角）
2. 批量决策混合输入 → `passed/failed` 且原因正确
3. 批量 patch 白名单（非法字段拒绝、合法字段 `rev+1`、`extra` 合并而非覆盖）
4. 缺口 close / reopen 状态流转 + 越权拒绝

**红线**：
- 不改 `v_confirmable_cards`、不绕过 `checkConfirmable`、不写整表 UPDATE
- 不新增迁移脚本；元数据只写 `extra jsonb`
- 新增查询一律 `withUserContext`

---

## 附录 · 字段映射（复制原 JSX 时按此替换）

| 原项目 | 新项目 |
|---|---|
| `c.external` | `c.externalOk` |
| `c.source` / `c.version` / `c.owner` | `c.extra.source` / `.version` / `.owner` |
| `c.runId` | `c.ingestRunId` |
| `c.evidence[].doc` | `c.evidence[].documentTitle` |
| `run.files[].path` | `ingest_files.source_path` |
| `run.files[].decision` = keep / skip / ask | `rule_keep / model_keep`；`rule_skip / model_skip`；`ask` |
| `run.counts.*` | `ingest_runs.counts` 同名键 |
| `q.sourceIds` | `qa_logs.cited_card_ids` |
| `q.gap` | `qa_logs.gap_id is not null` |
| `item.hits.length` | `regression_items.hit_ids` 长度 |
