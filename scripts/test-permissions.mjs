/**
 * 权限目录自检：不依赖数据库，验证 L1/L2/L3 上限、Scope 规则与模板合法性。
 *
 * 运行：npm run test:permissions
 */
import {
  ALL_PERMISSION_KEYS,
  DEFAULT_TEMPLATE_SCOPES,
  LEVEL_CEILING,
  PERMISSION_MODULES,
  PERMISSION_NODES,
  PROTECTED_CAPABILITIES,
  assertCatalogInvariants,
  enabledPermissionModules,
  isPermissionKey,
  isWithinCeiling,
  permissionKeysForModule,
} from "../src/lib/permissions/catalog.ts";
import {
  PERMISSION_SCOPES,
  isScopeWithin,
  scopeCoversResource,
  widestScope,
} from "../src/lib/permissions/scope.ts";

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

// 1. 目录自检
try {
  assertCatalogInvariants();
  check("目录不变量通过", true);
} catch (error) {
  check("目录不变量通过", false, error instanceof Error ? error.message : String(error));
}

// 2. 模块开关
const disabledModules = PERMISSION_MODULES.filter((module) => !module.enabled);
check(
  "未启用模块没有任何节点",
  disabledModules.every((module) => permissionKeysForModule(module.key).length === 0),
  disabledModules.map((module) => module.key).join(", "),
);
check(
  "启用模块都有节点",
  enabledPermissionModules().every((module) => permissionKeysForModule(module.key).length > 0),
);

// 3. 等级上限
check("L1 上限等于全部节点", LEVEL_CEILING.L1.length === ALL_PERMISSION_KEYS.length);
check(
  "L2 上限是 L1 的子集",
  LEVEL_CEILING.L2.every((key) => LEVEL_CEILING.L1.includes(key)),
);
check(
  "L3 上限是 L2 的子集",
  LEVEL_CEILING.L3.every((key) => LEVEL_CEILING.L2.includes(key)),
);
check("L2 不能管理成员", !isWithinCeiling("L2", "member:manage"));
check("L3 不能发布 Skill", !isWithinCeiling("L3", "skill:publish"));
check("L1 可以发布 Skill", isWithinCeiling("L1", "skill:publish"));

// 4. 高危节点默认关闭
check(
  "critical 节点默认关闭",
  PERMISSION_NODES.filter((node) => node.risk === "critical").every((node) => !node.defaultEnabled),
);

// 5. Scope 规则
check(
  "写类节点不含 DEPT_TREE",
  PERMISSION_NODES.filter((node) => node.action !== "read").every(
    (node) => !node.allowedScopes.includes("DEPT_TREE"),
  ),
);
check("DEPT_TREE 覆盖 DEPT", isScopeWithin("DEPT", "DEPT_TREE"));
check("DEPT 不覆盖 DEPT_TREE", !isScopeWithin("DEPT_TREE", "DEPT"));
check("ALL 覆盖 SELF", isScopeWithin("SELF", "ALL"));
check("SELF 不覆盖 DEPT", !isScopeWithin("DEPT", "SELF"));

// 6. 模板合法性
for (const [level, template] of Object.entries(DEFAULT_TEMPLATE_SCOPES)) {
  for (const [key, scope] of Object.entries(template)) {
    check(
      `${level} 模板节点在目录中：${key}`,
      isPermissionKey(key),
    );
    check(
      `${level} 模板节点在等级上限内：${key}`,
      isWithinCeiling(level, key),
    );
    const node = PERMISSION_NODES.find((item) => item.key === key);
    check(
      `${level} 模板 Scope 合法：${key}`,
      Boolean(node && PERMISSION_SCOPES.includes(scope) && node.allowedScopes.includes(scope)),
    );
  }
}

// 7. 资源作用域匹配
const base = {
  activeDepartmentId: "dept-a",
  subtreeDepartmentIds: ["dept-a", "dept-a-child"],
};
check(
  "DEPT 覆盖本部门",
  scopeCoversResource({ ...base, scope: "DEPT", resourceDepartmentId: "dept-a" }),
);
check(
  "DEPT 不覆盖子部门",
  !scopeCoversResource({ ...base, scope: "DEPT", resourceDepartmentId: "dept-a-child" }),
);
check(
  "DEPT_TREE 覆盖子部门",
  scopeCoversResource({ ...base, scope: "DEPT_TREE", resourceDepartmentId: "dept-a-child" }),
);
check(
  "DEPT_TREE 不覆盖兄弟部门",
  !scopeCoversResource({ ...base, scope: "DEPT_TREE", resourceDepartmentId: "dept-b" }),
);
check(
  "SELF 只覆盖本人资源",
  scopeCoversResource({ ...base, scope: "SELF", resourceDepartmentId: "dept-b", isOwnResource: true }) &&
    !scopeCoversResource({ ...base, scope: "SELF", resourceDepartmentId: "dept-a" }),
);

// 8. 保护区不进目录
check(
  "保护区 Key 不出现在权限目录",
  PROTECTED_CAPABILITIES.every((capability) => !ALL_PERMISSION_KEYS.includes(capability.key)),
);

// 9. 默认模板与目录一致
check(
  "L1 模板覆盖全部节点",
  Object.keys(DEFAULT_TEMPLATE_SCOPES.L1).length === ALL_PERMISSION_KEYS.length,
);
check(
  "每个节点都有最宽 Scope",
  PERMISSION_NODES.every((node) => widestScope(node.allowedScopes) !== null),
);

console.log(`\n[permissions] passed=${passed} failed=${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
