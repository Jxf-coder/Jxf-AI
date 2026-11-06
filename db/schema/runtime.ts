import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  bigint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";

import { aiEmployees } from "./ai-employees";
import { users } from "./auth";
import { departments } from "./departments";
import { runKind, runStatus } from "./enums";

/**
 * M3 · AI 运行时。
 *
 * 边界：
 * - threads 是一段连续对话的容器；runs 是一次执行（回合 / 任务 / 产线步骤）；
 * - runs 自己就是队列：状态 + 租约 + 尝试次数，不另建任务表；
 * - 事件按 seq 单调递增落库，delta 等瞬时内容只走推送，不落库；
 * - 所有表按 department_id 走 M1 的 app.can_read / app.can_write，不引入新机制。
 */

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    /** 冻结的岗位（memberships.position）；多岗位部门下用于区分 */
    roleKey: text("role_key"),
    /** 绑定的 AI 员工；为空表示通用助手 */
    aiEmployeeId: uuid("ai_employee_id").references(() => aiEmployees.id, { onDelete: "set null" }),
    title: text("title"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("threads_department_run_idx").on(table.departmentId, table.lastRunAt.desc()),
    index("threads_created_by_idx").on(table.createdBy),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    roleKey: text("role_key"),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    aiEmployeeId: uuid("ai_employee_id").references(() => aiEmployees.id, { onDelete: "set null" }),
    kind: runKind("kind").notNull(),
    status: runStatus("status").notNull().default("queued"),
    /** 幂等：同一 principal 的同一前端回合只会产生一个 run */
    clientTurnId: text("client_turn_id"),
    /** 发起人：运行时业务权限仍按该用户的部门上下文判定 */
    principalId: uuid("principal_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),

    // 队列与租约
    workerId: text("worker_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),

    // 续流：事件序号游标 + 累积文本快照（瞬时不落库，靠它恢复）
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    partialText: text("partial_text").notNull().default(""),
    partialUpdatedAt: timestamp("partial_updated_at", { withTimezone: true }),

    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // 用量冗余：列表页不必扫 token_usages
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    uniqueIndex("runs_client_turn_unique")
      .on(table.tenantId, table.principalId, table.clientTurnId)
      .where(sql`client_turn_id is not null`),
    index("runs_queue_idx")
      .on(table.status, table.leaseUntil)
      .where(sql`status in ('queued', 'running')`),
    index("runs_thread_created_idx").on(table.threadId, table.createdAt.desc()),
    index("runs_department_created_idx").on(table.departmentId, table.createdAt.desc()),
  ],
);

/** 一次模型调用 = 一步；工具循环 / 压缩重启都以它为单位 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    /** think | answer | tool_loop | compact */
    phase: text("phase").notNull(),
    model: text("model"),
    provider: text("provider"),
    finishReason: text("finish_reason"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("run_steps_run_ord_unique").on(table.runId, table.ord)],
);

/** durable 事件流：只落 status / step / tool / done / error / cancelled 等 */
export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** 反范式，供 RLS 与索引直接使用 */
    departmentId: uuid("department_id").notNull(),
    /** status | step | tool | done | error | cancelled | deposited */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index("run_events_department_created_idx").on(table.departmentId, table.createdAt.desc()),
  ],
);

/** 工具调用与耗时；也是审计的事件源 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => runSteps.id, { onDelete: "set null" }),
    departmentId: uuid("department_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** 写库前脱敏 */
    argsRedacted: jsonb("args_redacted").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** ok | error | denied | timeout */
    status: text("status").notNull(),
    resultChars: integer("result_chars"),
    resultPreview: text("result_preview"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tool_calls_run_idx").on(table.runId, table.createdAt),
    index("tool_calls_department_name_idx").on(table.departmentId, table.toolName, table.createdAt.desc()),
  ],
);

/** 成本账本：整数微元累加，不用浮点 */
export const tokenUsages = pgTable(
  "token_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepId: uuid("step_id").references(() => runSteps.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("token_usages_department_created_idx").on(table.departmentId, table.createdAt.desc()),
    index("token_usages_run_idx").on(table.runId),
  ],
);
