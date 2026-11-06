import { pgEnum } from "drizzle-orm/pg-core";

/** 访问等级：L1 最强 */
export const accessLevel = pgEnum("access_level", ["L1", "L2", "L3"]);

/**
 * 任用状态：
 * - active：在岗
 * - pending_removal：已发起移出，等待资产交接审批；禁止写操作
 * - removed：已停用（软删除，可恢复）
 */
export const membershipStatus = pgEnum("membership_status", [
  "active",
  "pending_removal",
  "removed",
]);

/**
 * 账号状态：
 * - active：可登录
 * - pending_handover：离职交接中，禁止登录
 * - disabled：已停用
 */
export const userStatus = pgEnum("user_status", ["active", "pending_handover", "disabled"]);

/* -------------------------------------------------------------------------- */
/* M2 · 知识库                                                                 */
/* -------------------------------------------------------------------------- */

/** 入库批次来源：上传 / 巡读（目录扫描）/ 手工 */
export const ingestKind = pgEnum("ingest_kind", ["upload", "scout", "manual"]);

/** 入库批次状态机 */
export const ingestStatus = pgEnum("ingest_status", [
  "draft",
  "running",
  "done",
  "failed",
  "revoked",
]);

/** 单文件处置结论：规则筛 / 模型判 / 待人工 / 出错 */
export const fileDecision = pgEnum("file_decision", [
  "pending",
  "rule_keep",
  "rule_skip",
  "model_keep",
  "model_skip",
  "ask",
  "error",
]);

/**
 * 文档状态：
 * - parsed：已解析出文本
 * - needs_ocr：扫描件/图片，暂不生成切片（不假装读过）
 * - failed：解析失败
 * - revoked：随批次撤回
 */
export const docStatus = pgEnum("doc_status", ["parsed", "needs_ocr", "failed", "revoked"]);

/** 知识卡类型 */
export const cardKind = pgEnum("card_kind", [
  "object",
  "decision",
  "preference",
  "fact",
  "faq",
  "case",
  "viewpoint",
]);

/** 知识卡状态：待确认 / 已确认 / 已丢弃 */
export const cardStatus = pgEnum("card_status", ["pending", "confirmed", "dropped"]);

/**
 * 公司共享审批状态：
 * - none：未申请（默认，visibility 保持 department）
 * - pending_approval：L2/普通成员已申请，等待 L1 审批；此期间不进入公共检索
 * - approved：L1 通过，visibility 才置为 shared
 * - rejected：L1 驳回，保持部门隔离
 */
export const shareStatus = pgEnum("share_status", [
  "none",
  "pending_approval",
  "approved",
  "rejected",
]);

/** 知识卡来源：开工问卷 / 提炼 / 手工 / 巡读 */
export const cardOrigin = pgEnum("card_origin", ["intake", "distill", "manual", "scout"]);

/** 知识缺口状态 */
export const gapStatus = pgEnum("gap_status", ["open", "answered", "closed"]);
