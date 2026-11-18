/**
 * 权限目录（唯一真相源）。
 *
 * 约束：
 * - 等级（L1/L2/L3）只是「上限」，不是权限集合。
 * - 每个节点必须声明允许的 Scope；写类动作禁止 DEPT_TREE。
 * - 保护区能力不在目录里，单独硬编码，永远只绑定 L1。
 * - 未启用模块（财务 / 教学）只保留模块位，不创建任何节点。
 */

import type { AccessLevel } from "@/types/profile";

import {
  widestScope,
  type PermissionScope,
} from "./scope";

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

export type PermissionModuleKey =
  | "member"
  | "org"
  | "skill"
  | "pipeline"
  | "knowledge"
  | "token"
  | "audit"
  | "platform"
  | "profile"
  | "crm"
  | "trade"
  | "mail"
  | "finance"
  | "teaching";

export interface PermissionModule {
  key: PermissionModuleKey;
  nameZh: string;
  description: string;
  /** false = 预留模块：不参与解析、不出现在配置面板 */
  enabled: boolean;
  order: number;
}

export const PERMISSION_MODULES: readonly PermissionModule[] = [
  {
    key: "member",
    nameZh: "成员管理",
    description: "组织内人员、任用与成员资料",
    enabled: true,
    order: 10,
  },
  {
    key: "org",
    nameZh: "组织架构",
    description: "部门树、岗位挂载与共享授权",
    enabled: true,
    order: 20,
  },
  {
    key: "skill",
    nameZh: "技能库",
    description: "Skill 的使用、编辑与发布",
    enabled: true,
    order: 30,
  },
  {
    key: "pipeline",
    nameZh: "产线与自动化",
    description: "自动化产线的运行与配置",
    enabled: true,
    order: 40,
  },
  {
    key: "knowledge",
    nameZh: "知识库",
    description: "知识卡、巡读与交接包",
    enabled: true,
    order: 50,
  },
  {
    key: "token",
    nameZh: "MCP 令牌",
    description: "外部 AI 客户端的个人令牌",
    enabled: true,
    order: 60,
  },
  {
    key: "audit",
    nameZh: "审计",
    description: "组织、权限与资料变更记录",
    enabled: true,
    order: 70,
  },
  {
    key: "platform",
    nameZh: "平台设置",
    description: "系统级配置与租户治理",
    enabled: true,
    order: 80,
  },
  {
    key: "profile",
    nameZh: "个人资料",
    description: "本人核心资料与邮箱",
    enabled: true,
    order: 90,
  },
  {
    key: "crm",
    nameZh: "客户与 CRM",
    description: "客户、联系人、公共池、合并、导入导出与提醒",
    enabled: true,
    order: 100,
  },
  {
    key: "trade",
    nameZh: "交易链",
    description: "产品、报价、合同、出货、应收与样品",
    enabled: true,
    order: 110,
  },
  {
    key: "mail",
    nameZh: "邮件中心",
    description: "邮箱账号、收发、分发与群发",
    enabled: true,
    order: 120,
  },
  {
    key: "finance",
    nameZh: "财务与经营",
    description: "预留模块：本轮不创建权限节点",
    enabled: false,
    order: 900,
  },
  {
    key: "teaching",
    nameZh: "教学与教务",
    description: "预留模块：本轮不创建权限节点",
    enabled: false,
    order: 910,
  },
] as const;

const MODULE_MAP = new Map(PERMISSION_MODULES.map((module) => [module.key, module]));

export function getPermissionModule(key: PermissionModuleKey): PermissionModule {
  const module = MODULE_MAP.get(key);
  if (!module) {
    throw new Error(`未知权限模块：${key}`);
  }
  return module;
}

export function enabledPermissionModules(): PermissionModule[] {
  return PERMISSION_MODULES.filter((module) => module.enabled).sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

export type PermissionAction = "read" | "write" | "manage" | "publish" | "approve";

export type PermissionRisk = "low" | "medium" | "high" | "critical";

export type PermissionKey =
  | "member:view"
  | "member:profile"
  | "member:manage"
  | "member:level"
  | "member:ssh"
  | "org:view"
  | "org:manage"
  | "org:grant"
  | "skill:use"
  | "skill:edit"
  | "skill:publish"
  | "skill:create"
  | "pipeline:use"
  | "pipeline:manage"
  | "knowledge:read"
  | "knowledge:write"
  | "knowledge:confirm"
  | "knowledge:export"
  | "token:issue"
  | "token:revoke"
  | "audit:read"
  | "platform:settings"
  | "platform:tenant"
  | "profile:view_self"
  | "profile:edit_self"
  | "crm:read"
  | "crm:write"
  | "crm:assign"
  | "crm:claim"
  | "crm:merge"
  | "crm:import"
  | "crm:export"
  | "crm:pool_policy"
  | "crm:holder_cap"
  | "crm:dict_manage"
  | "crm:reminder_read"
  | "crm:reminder_urge"
  | "crm:reminder_manage"
  | "crm:alert_close"
  | "crm:complaint_manage"
  | "trade:product_read"
  | "trade:product_write"
  | "trade:quote_read"
  | "trade:quote_write"
  | "trade:contract_read"
  | "trade:contract_write"
  | "trade:contract_approve"
  | "trade:receivable_read"
  | "trade:receivable_write"
  | "trade:export"
  | "trade:sample_read"
  | "trade:sample_write"
  | "trade:price_read"
  | "trade:credit_read"
  | "trade:floor_price_read"
  | "trade:fx_lock_read"
  | "trade:credit_policy"
  | "mail:account_read"
  | "mail:account_manage"
  | "mail:send"
  | "mail:distribute"
  | "mail:campaign"
  | "mail:suppression_manage"
  | "mail:archive_export";

export interface PermissionNode {
  key: PermissionKey;
  module: PermissionModuleKey;
  nameZh: string;
  description: string;
  action: PermissionAction;
  risk: PermissionRisk;
  /** 默认模板是否开启；高危节点必须为 false */
  defaultEnabled: boolean;
  /** 是否允许在配置面板里勾选；保护区节点不进目录，因此这里只用于特殊节点 */
  grantable: boolean;
  /** 需要二次确认或审批 */
  requiresApproval: boolean;
  /** 允许授予的 Scope；按从宽到窄排列，第一项用作 L1 默认 */
  allowedScopes: readonly PermissionScope[];
  /** 隐含的其他节点；用于组合判定与 UI 提示 */
  implies?: readonly PermissionKey[];
}

export const PERMISSION_NODES: readonly PermissionNode[] = [
  {
    key: "member:view",
    module: "member",
    nameZh: "查看成员",
    description: "查看成员名单、基础资料与所属部门",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "member:profile",
    module: "member",
    nameZh: "编辑成员资料",
    description: "修改成员姓名、手机号、业务岗位与头像",
    action: "write",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "member:manage",
    module: "member",
    nameZh: "管理成员",
    description: "添加成员、移出成员、调整所属部门",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "member:level",
    module: "member",
    nameZh: "调整权限等级",
    description: "修改成员的 L1 / L2 / L3 等级",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "member:ssh",
    module: "member",
    nameZh: "管理 SSH 访问",
    description: "开启或关闭 L2 成员的 SSH 与公钥",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "org:view",
    module: "org",
    nameZh: "查看组织架构",
    description: "查看部门树、部门成员与组织关系",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "org:manage",
    module: "org",
    nameZh: "管理组织架构",
    description: "新建、改名、删除部门与调整同级顺序",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "org:grant",
    module: "org",
    nameZh: "管理共享授权",
    description: "配置授权包与交换频道的读写名单",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "skill:use",
    module: "skill",
    nameZh: "使用 Skill",
    description: "打开并使用已上架的 Skill",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL"],
  },
  {
    key: "skill:edit",
    module: "skill",
    nameZh: "编辑 Skill",
    description: "修改 Skill 配置与提示词",
    action: "write",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL"],
  },
  {
    key: "skill:publish",
    module: "skill",
    nameZh: "发布 Skill",
    description: "构建并发布 Skill 到生产环境",
    action: "publish",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "skill:create",
    module: "skill",
    nameZh: "新建 Skill",
    description: "创建新的外部 Skill",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "pipeline:use",
    module: "pipeline",
    nameZh: "运行产线",
    description: "启动自动化产线与任务",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL"],
  },
  {
    key: "pipeline:manage",
    module: "pipeline",
    nameZh: "管理产线",
    description: "修改产线配置、模式与质检尺度",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "knowledge:read",
    module: "knowledge",
    nameZh: "查看知识库",
    description: "查看知识条目、知识卡与缺口",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "knowledge:write",
    module: "knowledge",
    nameZh: "写入知识库",
    description: "新增或修改知识条目与知识卡",
    action: "write",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "knowledge:confirm",
    module: "knowledge",
    nameZh: "确认知识卡",
    description: "确认、驳回或删除知识卡",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "knowledge:export",
    module: "knowledge",
    nameZh: "导出知识交接包",
    description: "导出知识库交接包与证据清单",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "token:issue",
    module: "token",
    nameZh: "签发 MCP 令牌",
    description: "为成员签发外部客户端访问令牌",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "token:revoke",
    module: "token",
    nameZh: "停用 MCP 令牌",
    description: "停用或删除已签发的令牌",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "audit:read",
    module: "audit",
    nameZh: "查看审计日志",
    description: "查看组织、权限与资料变更记录",
    action: "read",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "platform:settings",
    module: "platform",
    nameZh: "管理系统设置",
    description: "修改品牌、模型密钥、连接器等全局设置",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "platform:tenant",
    module: "platform",
    nameZh: "管理租户与行业",
    description: "修改租户策略、行业能力与套餐",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "profile:view_self",
    module: "profile",
    nameZh: "查看本人资料",
    description: "查看本人姓名、手机号、邮箱与任用",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["SELF"],
  },
  {
    key: "profile:edit_self",
    module: "profile",
    nameZh: "编辑本人资料",
    description: "修改本人姓名、手机号、头像与邮箱",
    action: "write",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["SELF"],
  },
  {
    key: "crm:read",
    module: "crm",
    nameZh: "查看客户与联系人",
    description: "查看客户档案、联系人与时间线",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "crm:write",
    module: "crm",
    nameZh: "编辑客户与联系人",
    description: "新建、编辑客户档案与联系人",
    action: "write",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "crm:assign",
    module: "crm",
    nameZh: "分派与置公",
    description: "分派、移交、置公与重点池分配",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:claim",
    module: "crm",
    nameZh: "公共池领用",
    description: "从公共池自助领用客户",
    action: "write",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["SELF"],
  },
  {
    key: "crm:merge",
    module: "crm",
    nameZh: "客户合并",
    description: "合并重复客户并迁移关联数据",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:import",
    module: "crm",
    nameZh: "批量导入",
    description: "导入客户、联系人与产品数据",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:export",
    module: "crm",
    nameZh: "客户与交易导出",
    description: "导出客户与交易数据（异步打包）",
    action: "write",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:pool_policy",
    module: "crm",
    nameZh: "公共池策略",
    description: "配置私海上限、重点池阈值与候选超时",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:holder_cap",
    module: "crm",
    nameZh: "设置个体私海上限",
    description: "为单个成员覆盖私海持有上限",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:dict_manage",
    module: "crm",
    nameZh: "CRM 字典与编号",
    description: "维护业务字典与编号规则",
    action: "manage",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:reminder_read",
    module: "crm",
    nameZh: "查看提醒",
    description: "查看客户、报价、合同与邮件提醒",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "crm:reminder_urge",
    module: "crm",
    nameZh: "督办与确认提醒",
    description: "督办、确认或转交提醒",
    action: "manage",
    risk: "low",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:reminder_manage",
    module: "crm",
    nameZh: "配置提醒规则",
    description: "配置提醒阈值与升级链",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "crm:alert_close",
    module: "crm",
    nameZh: "关闭红线告警",
    description: "关闭或终止升级到 L1 的红线告警",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "crm:complaint_manage",
    module: "crm",
    nameZh: "投诉与索赔",
    description: "记录与处理客户投诉、索赔",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "trade:product_read",
    module: "trade",
    nameZh: "查看产品",
    description: "查看产品档案、类别与包装信息",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:product_write",
    module: "trade",
    nameZh: "维护产品",
    description: "新建与编辑产品、产品类别",
    action: "write",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "trade:quote_read",
    module: "trade",
    nameZh: "查看报价",
    description: "查看报价单与历史版本",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "trade:quote_write",
    module: "trade",
    nameZh: "新建与发送报价",
    description: "新建、编辑并发送报价单",
    action: "write",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "trade:contract_read",
    module: "trade",
    nameZh: "查看合同与出货",
    description: "查看合同、出货记录与应收",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "trade:contract_write",
    module: "trade",
    nameZh: "新建与编辑合同",
    description: "新建、编辑合同并提交审批",
    action: "write",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "trade:contract_approve",
    module: "trade",
    nameZh: "合同与折扣审批",
    description: "审批合同与低于底价的折扣",
    action: "approve",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "trade:receivable_read",
    module: "trade",
    nameZh: "查看应收台账",
    description: "查看应收明细与回款状态",
    action: "read",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:receivable_write",
    module: "trade",
    nameZh: "登记回款与核销",
    description: "登记回款并核销应收账款",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "trade:export",
    module: "trade",
    nameZh: "交易与应收导出",
    description: "导出贸易交易与应收（异步打包）",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "trade:sample_read",
    module: "trade",
    nameZh: "查看样品与寄样",
    description: "查看来样、寄样与快件记录",
    action: "read",
    risk: "low",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "trade:sample_write",
    module: "trade",
    nameZh: "登记样品与寄样",
    description: "登记来样、样品出库与寄样",
    action: "write",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "trade:price_read",
    module: "trade",
    nameZh: "成本与毛利",
    description: "查看成本、采购价与毛利",
    action: "read",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:credit_read",
    module: "trade",
    nameZh: "客户信用额度",
    description: "查看信用额度、银行账号与中信保限额",
    action: "read",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:floor_price_read",
    module: "trade",
    nameZh: "底价与折扣红线",
    description: "查看最低底价与折扣红线",
    action: "read",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:fx_lock_read",
    module: "trade",
    nameZh: "内部锁汇汇率",
    description: "查看报价与合同的内部锁汇汇率",
    action: "read",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT"],
  },
  {
    key: "trade:credit_policy",
    module: "trade",
    nameZh: "授信与结算策略",
    description: "修改授信阈值、银行信息与中信保",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: false,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
  {
    key: "mail:account_read",
    module: "mail",
    nameZh: "查看邮箱与邮件",
    description: "查看被授权的邮箱与邮件内容",
    action: "read",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["ALL", "DEPT_TREE", "DEPT", "SELF"],
  },
  {
    key: "mail:account_manage",
    module: "mail",
    nameZh: "管理邮箱账号",
    description: "新建、停用邮箱并修改连接配置",
    action: "manage",
    risk: "critical",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "mail:send",
    module: "mail",
    nameZh: "发信",
    description: "通过已授权邮箱发送邮件",
    action: "write",
    risk: "medium",
    defaultEnabled: true,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT", "SELF"],
  },
  {
    key: "mail:distribute",
    module: "mail",
    nameZh: "邮件分发",
    description: "配置分发规则与入站归属",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "mail:campaign",
    module: "mail",
    nameZh: "群发与效果跟踪",
    description: "创建群发任务并查看送达、打开与回复",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["DEPT"],
  },
  {
    key: "mail:suppression_manage",
    module: "mail",
    nameZh: "退信与黑名单",
    description: "解除抑制与维护黑名单",
    action: "manage",
    risk: "medium",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: false,
    allowedScopes: ["DEPT"],
  },
  {
    key: "mail:archive_export",
    module: "mail",
    nameZh: "退信冷数据导出",
    description: "导出归档的退信冷数据 CSV",
    action: "write",
    risk: "high",
    defaultEnabled: false,
    grantable: true,
    requiresApproval: true,
    allowedScopes: ["ALL"],
  },
] as const;

const NODE_MAP = new Map<string, PermissionNode>(PERMISSION_NODES.map((node) => [node.key, node]));

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && NODE_MAP.has(value);
}

export function getPermissionNode(key: PermissionKey): PermissionNode {
  const node = NODE_MAP.get(key);
  if (!node) {
    throw new Error(`未知权限节点：${key}`);
  }
  return node;
}

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_NODES.map((node) => node.key);

export function permissionKeysForModule(module: PermissionModuleKey): PermissionKey[] {
  return PERMISSION_NODES.filter((node) => node.module === module).map((node) => node.key);
}

export function enabledPermissionKeys(): PermissionKey[] {
  return PERMISSION_NODES.filter((node) => getPermissionModule(node.module).enabled).map((node) => node.key);
}

// ---------------------------------------------------------------------------
// 等级上限
// ---------------------------------------------------------------------------

export const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = {
  L1: "L1 老板",
  L2: "L2 部门管理者",
  L3: "L3 普通成员",
};

const L2_CEILING: readonly PermissionKey[] = [
  "member:view",
  "member:profile",
  "org:view",
  "skill:use",
  "skill:edit",
  "pipeline:use",
  "knowledge:read",
  "knowledge:write",
  "knowledge:confirm",
  "audit:read",
  "profile:view_self",
  "profile:edit_self",
  "crm:read",
  "crm:write",
  "crm:assign",
  "crm:claim",
  "crm:merge",
  "crm:import",
  "crm:export",
  "crm:pool_policy",
  "crm:holder_cap",
  "crm:reminder_read",
  "crm:reminder_urge",
  "crm:complaint_manage",
  "trade:product_read",
  "trade:product_write",
  "trade:quote_read",
  "trade:quote_write",
  "trade:contract_read",
  "trade:contract_write",
  "trade:contract_approve",
  "trade:receivable_read",
  "trade:receivable_write",
  "trade:export",
  "trade:sample_read",
  "trade:sample_write",
  "mail:account_read",
  "mail:account_manage",
  "mail:send",
  "mail:distribute",
  "mail:campaign",
  "mail:suppression_manage",
];

const L3_CEILING: readonly PermissionKey[] = [
  "member:view",
  "org:view",
  "skill:use",
  "pipeline:use",
  "knowledge:read",
  "profile:view_self",
  "profile:edit_self",
  "crm:read",
  "crm:write",
  "crm:claim",
  "crm:reminder_read",
  "trade:product_read",
  "trade:quote_read",
  "trade:quote_write",
  "trade:contract_read",
  "trade:contract_write",
  "trade:sample_read",
  "trade:sample_write",
  "mail:account_read",
  "mail:send",
];

export const LEVEL_CEILING: Record<AccessLevel, readonly PermissionKey[]> = {
  L1: ALL_PERMISSION_KEYS,
  L2: L2_CEILING,
  L3: L3_CEILING,
};

export function isWithinCeiling(level: AccessLevel, key: PermissionKey): boolean {
  return LEVEL_CEILING[level].includes(key);
}

// ---------------------------------------------------------------------------
// 默认模板
// ---------------------------------------------------------------------------

export type TemplateScopes = Partial<Record<PermissionKey, PermissionScope>>;

function widestFor(key: PermissionKey): PermissionScope {
  const scopes = getPermissionNode(key).allowedScopes;
  const scope = widestScope(scopes);
  if (!scope) {
    throw new Error(`权限节点缺少 Scope：${key}`);
  }
  return scope;
}

function buildTemplate(keys: readonly PermissionKey[], scopes: Partial<Record<PermissionKey, PermissionScope>>): TemplateScopes {
  const out: TemplateScopes = {};
  for (const key of keys) {
    out[key] = scopes[key] ?? widestFor(key);
  }
  return out;
}

export const DEFAULT_TEMPLATE_SCOPES: Record<AccessLevel, TemplateScopes> = {
  L1: buildTemplate(LEVEL_CEILING.L1, {}),
  L2: buildTemplate(LEVEL_CEILING.L2, {
    "member:view": "DEPT_TREE",
    "member:profile": "DEPT",
    "org:view": "DEPT_TREE",
    "knowledge:read": "DEPT_TREE",
    "knowledge:write": "DEPT",
    "knowledge:confirm": "DEPT",
    "audit:read": "DEPT_TREE",
    "profile:view_self": "SELF",
    "profile:edit_self": "SELF",
    "crm:read": "DEPT_TREE",
    "crm:write": "DEPT",
    "crm:claim": "SELF",
    "crm:reminder_read": "DEPT_TREE",
    "trade:product_read": "DEPT_TREE",
    "trade:quote_read": "DEPT_TREE",
    "trade:quote_write": "DEPT",
    "trade:contract_read": "DEPT_TREE",
    "trade:contract_write": "DEPT",
    "trade:receivable_read": "DEPT_TREE",
    "trade:export": "DEPT",
    "trade:sample_read": "DEPT_TREE",
    "trade:sample_write": "DEPT",
    "mail:account_read": "DEPT_TREE",
    "mail:send": "DEPT",
  }),
  L3: buildTemplate(LEVEL_CEILING.L3, {
    "member:view": "SELF",
    "org:view": "DEPT",
    "knowledge:read": "DEPT",
    "profile:view_self": "SELF",
    "profile:edit_self": "SELF",
    "crm:read": "DEPT",
    "crm:write": "SELF",
    "crm:claim": "SELF",
    "crm:reminder_read": "SELF",
    "trade:product_read": "DEPT",
    "trade:quote_read": "SELF",
    "trade:quote_write": "SELF",
    "trade:contract_read": "SELF",
    "trade:contract_write": "SELF",
    "trade:sample_read": "SELF",
    "trade:sample_write": "SELF",
    "mail:account_read": "SELF",
    "mail:send": "SELF",
  }),
};

// ---------------------------------------------------------------------------
// 保护区（不进目录、不可授权）
// ---------------------------------------------------------------------------

export type ProtectedCapabilityKey =
  | "protected:secrets"
  | "protected:root_account"
  | "protected:permission_grant"
  | "protected:tenant"
  | "protected:protected_path";

export interface ProtectedCapability {
  key: ProtectedCapabilityKey;
  nameZh: string;
  description: string;
}

export const PROTECTED_CAPABILITIES: readonly ProtectedCapability[] = [
  {
    key: "protected:secrets",
    nameZh: "密钥管理",
    description: "模型密钥、部署密钥与内部签名密钥",
  },
  {
    key: "protected:root_account",
    nameZh: "根账号管理",
    description: "系统根账号与最后一个 L1 的保护",
  },
  {
    key: "protected:permission_grant",
    nameZh: "权限授权",
    description: "修改角色模板与成员授权本身",
  },
  {
    key: "protected:tenant",
    nameZh: "租户治理",
    description: "租户策略、行业能力与升级",
  },
  {
    key: "protected:protected_path",
    nameZh: "代码保护区",
    description: "认证、成员、令牌与部署脚本等敏感路径",
  },
] as const;

const PROTECTED_KEY_SET = new Set<string>(PROTECTED_CAPABILITIES.map((capability) => capability.key));

export function isProtectedCapabilityKey(value: unknown): value is ProtectedCapabilityKey {
  return typeof value === "string" && PROTECTED_KEY_SET.has(value);
}

export function getProtectedCapability(key: ProtectedCapabilityKey): ProtectedCapability {
  const capability = PROTECTED_CAPABILITIES.find((item) => item.key === key);
  if (!capability) {
    throw new Error(`未知保护区能力：${key}`);
  }
  return capability;
}

// ---------------------------------------------------------------------------
// 目录自检：测试与构建期都可用
// ---------------------------------------------------------------------------

export function assertCatalogInvariants(): void {
  const keys = new Set<string>();

  for (const node of PERMISSION_NODES) {
    if (keys.has(node.key)) {
      throw new Error(`权限 Key 重复：${node.key}`);
    }
    keys.add(node.key);

    if (!getPermissionModule(node.module).enabled) {
      throw new Error(`节点属于未启用模块：${node.key}`);
    }

    if (node.action !== "read" && node.allowedScopes.includes("DEPT_TREE")) {
      throw new Error(`写类节点不允许 DEPT_TREE：${node.key}`);
    }

    if (node.risk === "critical" && node.defaultEnabled) {
      throw new Error(`高危节点默认必须关闭：${node.key}`);
    }

    for (const scope of node.allowedScopes) {
      if (node.action !== "read" && scope === "DEPT_TREE") {
        throw new Error(`写类节点不允许 DEPT_TREE：${node.key}`);
      }
    }
  }

  for (const [level, ceiling] of Object.entries(LEVEL_CEILING) as Array<[AccessLevel, readonly PermissionKey[]]>) {
    for (const key of ceiling) {
      if (!keys.has(key)) {
        throw new Error(`${level} 上限包含未知节点：${key}`);
      }
    }
  }

  for (const module of PERMISSION_MODULES) {
    if (!module.enabled && permissionKeysForModule(module.key).length > 0) {
      throw new Error(`未启用模块不应有节点：${module.key}`);
    }
  }
}
