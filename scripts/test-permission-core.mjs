/**
 * P2 鉴权核心自检：不依赖数据库。
 *
 * 运行：npm run test:permission-core
 */
import {
  DEFAULT_TEMPLATE_SCOPES,
  LEVEL_CEILING,
  PERMISSION_NODES,
} from "../src/lib/permissions/catalog.ts";
import { authorize, authorizeProtected } from "../src/lib/permissions/authorize.ts";
import { canGrant } from "../src/lib/permissions/grant.ts";
import { PermissionDeniedError, requirePermission } from "../src/lib/permissions/guard.ts";
import { resolveEffectivePermissions } from "../src/lib/permissions/resolve.ts";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    return;
  }
  failed += 1;
  console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
}

function templateRules(level) {
  return Object.entries(DEFAULT_TEMPLATE_SCOPES[level]).map(([permissionKey, scope]) => ({
    permissionKey,
    scope,
    effect: "allow",
  }));
}

function resolve(level, userGrants = [], overrides = {}) {
  return resolveEffectivePermissions({
    userId: overrides.userId ?? "actor-1",
    level,
    activeMembershipId: `membership-${level}`,
    activeDepartmentId: "dept-a",
    subtreeDepartmentIds: ["dept-a", "dept-a-child"],
    templateGrants: templateRules(level),
    userGrants,
    version: 1,
  });
}

function expectDenied(name, result, matcher) {
  check(
    name,
    !result.allowed && (!matcher || result.reason.includes(matcher)),
    result.allowed ? "预期拒绝但通过" : result.reason,
  );
}

function expectAllowed(name, result) {
  check(name, result.allowed, result.reason);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

const l1 = resolve("L1");
check("L1 解析为全部节点", l1.grants.size === LEVEL_CEILING.L1.length);

const l1WithDeny = resolve("L1", [{ permissionKey: "member:view", scope: "ALL", effect: "deny" }]);
check(
  "L1 不受用户 deny 影响",
  l1WithDeny.grants.has("member:view") && l1WithDeny.denies.size === 0,
);

const l2 = resolve("L2");
check("L2 模板解析为 12 个节点", l2.grants.size === 12, String(l2.grants.size));
check("L2 member:view 为 DEPT_TREE", l2.grants.get("member:view") === "DEPT_TREE");

const l3 = resolve("L3");
check("L3 模板解析为 7 个节点", l3.grants.size === 7, String(l3.grants.size));
check("L3 member:view 为 SELF", l3.grants.get("member:view") === "SELF");

const l3OverCeiling = resolve("L3", [
  { permissionKey: "skill:publish", scope: "ALL", effect: "allow" },
]);
check("L3 越级授权被忽略", !l3OverCeiling.grants.has("skill:publish"));
check("L3 越级授权记录 ignoredKeys", l3OverCeiling.ignoredKeys.includes("skill:publish"));

const l3Unknown = resolve("L3", [
  { permissionKey: "finance:export", scope: "ALL", effect: "allow" },
]);
check(
  "未启用模块授权被忽略",
  !l3Unknown.grants.has("finance:export") && l3Unknown.ignoredKeys.includes("finance:export"),
);

const l3BadScope = resolve("L3", [
  { permissionKey: "knowledge:read", scope: "DEPTTREE", effect: "allow" },
]);
check("非法 Scope 被忽略", l3BadScope.ignoredKeys.includes("knowledge:read"));

const l2Denied = resolve("L2", [
  { permissionKey: "skill:use", scope: "ALL", effect: "deny" },
]);
check(
  "deny 覆盖模板 allow",
  !l2Denied.grants.has("skill:use") && l2Denied.denies.has("skill:use"),
);

const l2Expired = resolve("L2", [
  {
    permissionKey: "member:profile",
    scope: "DEPT",
    effect: "allow",
    expiresAt: "2020-01-01T00:00:00.000Z",
  },
]);
check("过期授权被忽略", l2Expired.ignoredKeys.includes("member:profile"));

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

const l3Self = { ...l3, userId: "self" };

expectAllowed(
  "L3 可查看本人",
  authorize(l3Self, "member:view", { kind: "user", departmentId: "dept-a", ownerUserId: "self" }),
);
expectDenied(
  "L3 不能查看他人",
  authorize(l3Self, "member:view", { kind: "user", departmentId: "dept-a", ownerUserId: "other" }),
  "仅本人",
);
expectAllowed(
  "L2 可读子部门成员",
  authorize(l2, "member:view", { kind: "user", departmentId: "dept-a-child" }),
);
expectDenied(
  "L2 不能读兄弟部门成员",
  authorize(l2, "member:view", { kind: "user", departmentId: "dept-b" }),
  "不在范围内",
);
expectAllowed(
  "L2 可写本部门知识",
  authorize(l2, "knowledge:write", { kind: "knowledge", departmentId: "dept-a" }),
);
expectDenied(
  "L2 不能写子部门知识",
  authorize(l2, "knowledge:write", { kind: "knowledge", departmentId: "dept-a-child" }),
  "不在范围内",
);
expectDenied(
  "L2 不能管理成员",
  authorize(l2, "member:manage", { kind: "membership", departmentId: "dept-a" }),
  "当前等级",
);
expectAllowed(
  "L1 默认通过",
  authorize(l1, "platform:settings", { kind: "settings", departmentId: null }),
);
expectDenied(
  "未知节点默认拒绝",
  authorize(l2, "unknown:key", { kind: "x", departmentId: null }),
  "未知",
);

expectAllowed("L1 可访问保护区", authorizeProtected(l1, "protected:secrets"));
expectDenied("L2 不能访问保护区", authorizeProtected(l2, "protected:secrets"), "保护区");

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------

try {
  requirePermission(l2, "member:view");
  check("guard 对非 ALL 节点强制资源上下文", false, "预期抛错但通过");
} catch (error) {
  check(
    "guard 对非 ALL 节点强制资源上下文",
    error instanceof PermissionDeniedError && error.status === 403,
  );
}

check("guard 允许 ALL 节点无资源", requirePermission(l2, "skill:use").allowed);
check(
  "guard 允许本部门资源",
  requirePermission(l2, "member:view", { kind: "user", departmentId: "dept-a" }).allowed,
);

// ---------------------------------------------------------------------------
// canGrant
// ---------------------------------------------------------------------------

expectAllowed(
  "L1 可给 L2 授予 DEPT_TREE 查看",
  canGrant(l1, { userId: "u2", level: "L2" }, {
    permissionKey: "member:view",
    scope: "DEPT_TREE",
    effect: "allow",
  }),
);
expectDenied(
  "L1 不能给 L2 授予 member:manage",
  canGrant(l1, { userId: "u2", level: "L2" }, {
    permissionKey: "member:manage",
    scope: "DEPT",
    effect: "allow",
  }),
  "目标成员等级",
);
expectDenied(
  "系统保留节点不可授予",
  canGrant(l1, { userId: "u2", level: "L2" }, {
    permissionKey: "member:level",
    scope: "DEPT",
    effect: "allow",
  }),
  "系统保留",
);
expectDenied(
  "非 L1 不能修改授权",
  canGrant(l2, { userId: "u2", level: "L3" }, {
    permissionKey: "member:view",
    scope: "SELF",
    effect: "allow",
  }),
  "仅 L1",
);
expectDenied(
  "过期时间不能是过去",
  canGrant(l1, { userId: "u2", level: "L2" }, {
    permissionKey: "member:view",
    scope: "DEPT",
    effect: "allow",
    expiresAt: "2020-01-01T00:00:00.000Z",
  }),
  "晚于当前时间",
);
expectDenied(
  "写动作不能授予 DEPT_TREE",
  canGrant(l1, { userId: "u2", level: "L2" }, {
    permissionKey: "knowledge:write",
    scope: "DEPT_TREE",
    effect: "allow",
  }),
  "不支持该作用域",
);

// ---------------------------------------------------------------------------
// P4 写入口映射（组织 / 成员 / 资料）
// ---------------------------------------------------------------------------

expectAllowed(
  "L2 可编辑本部门成员资料",
  authorize(l2, "member:profile", { kind: "user", departmentId: "dept-a", ownerUserId: "other" }),
);
expectDenied(
  "L2 不能编辑子部门成员资料",
  authorize(l2, "member:profile", {
    kind: "user",
    departmentId: "dept-a-child",
    ownerUserId: "other",
  }),
  "不在范围内",
);
expectDenied(
  "L2 不能调整成员等级",
  authorize(l2, "member:level", { kind: "membership", departmentId: "dept-a" }),
  "当前等级",
);
expectDenied(
  "L2 不能管理组织架构",
  authorize(l2, "org:manage", { kind: "department", departmentId: "dept-a" }),
  "当前等级",
);
expectDenied(
  "L3 不能编辑他人资料",
  authorize(l3, "member:profile", { kind: "user", departmentId: "dept-a", ownerUserId: "other" }),
  "当前等级",
);
expectAllowed(
  "L3 可编辑本人资料",
  authorize(l3Self, "profile:edit_self", {
    kind: "user",
    departmentId: "dept-a",
    ownerUserId: "self",
  }),
);
expectDenied(
  "L3 不能编辑他人资料（SELF 作用域）",
  authorize(l3Self, "profile:edit_self", {
    kind: "user",
    departmentId: "dept-a",
    ownerUserId: "other",
  }),
  "仅本人",
);

// ---------------------------------------------------------------------------
// 目录一致性
// ---------------------------------------------------------------------------

check("目录节点数固定为 25", PERMISSION_NODES.length === 25, String(PERMISSION_NODES.length));

console.log(`\n[permission-core] passed=${passed} failed=${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
