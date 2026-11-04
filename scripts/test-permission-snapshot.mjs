/**
 * P5 权限快照与客户端预检自检：不依赖数据库。
 *
 * 运行：npm run test:snapshot
 */
import {
  checkSnapshot,
  toPermissionSnapshot,
} from "../src/lib/permissions/snapshot.ts";

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

const actor = {
  userId: "u2",
  level: "L2",
  activeMembershipId: "m2",
  activeDepartmentId: "dept-a",
  subtreeDepartmentIds: ["dept-a", "dept-child"],
  version: 3,
  grants: new Map([
    ["member:view", "DEPT_TREE"],
    ["profile:view_self", "SELF"],
    ["profile:edit_self", "SELF"],
  ]),
  denies: new Set(["skill:edit"]),
  ignoredKeys: [],
};

const snapshot = toPermissionSnapshot(actor);

check("快照版本号透传", snapshot.version === 3);
check("快照等级透传", snapshot.level === "L2");
check("快照部门透传", snapshot.activeDepartmentId === "dept-a");
check("Map 转为普通对象", snapshot.grants["member:view"] === "DEPT_TREE");
check("denies 转为数组", snapshot.denies.includes("skill:edit"));

check("无快照默认拒绝", !checkSnapshot(null, "member:view").allowed);
check("无快照原因可读", checkSnapshot(null, "member:view").reason.includes("有效任用"));

check("DEPT_TREE 覆盖 DEPT", checkSnapshot(snapshot, "member:view", "DEPT").allowed);
check("DEPT_TREE 覆盖自身", checkSnapshot(snapshot, "member:view", "DEPT_TREE").allowed);
check("DEPT_TREE 不覆盖 ALL", !checkSnapshot(snapshot, "member:view", "ALL").allowed);
check(
  "Scope 不足原因可读",
  checkSnapshot(snapshot, "member:view", "ALL").reason.includes("全租户"),
);

check("SELF 节点可用", checkSnapshot(snapshot, "profile:edit_self", "SELF").allowed);
check("缺失节点默认拒绝", !checkSnapshot(snapshot, "org:manage").allowed);
check(
  "缺失节点原因带 key",
  checkSnapshot(snapshot, "org:manage").reason.includes("org:manage"),
);
check("deny 覆盖 allow", !checkSnapshot(snapshot, "skill:edit").allowed);
check(
  "deny 原因可读",
  checkSnapshot(snapshot, "skill:edit").reason.includes("显式拒绝"),
);

const l1Snapshot = {
  version: 1,
  level: "L1",
  activeDepartmentId: "dept-a",
  activeMembershipId: "m1",
  grants: {},
  denies: [],
};
check("L1 默认全量通过", checkSnapshot(l1Snapshot, "platform:settings", "ALL").allowed);

console.log(`\n[permission-snapshot] passed=${passed} failed=${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
