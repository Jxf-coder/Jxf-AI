/**
 * P4 守卫覆盖检查：扫描所有 Server Action 与 Route Handler。
 *
 * 规则：每个导出入口都必须调用 requireContextPermission() / requirePermission()；
 * 公开探针、认证框架入口与纯上下文切换必须列入白名单并注明原因。
 *
 * 运行：npm run verify:guards
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd(), "src", "app");

/**
 * 允许不接权限守卫的入口。
 * reason 必须写清为什么不属于业务写入口，避免白名单变成永久豁免区。
 */
const WHITELIST = new Map([
  [
    "src/app/(app)/actions.ts::switchActiveDepartment",
    "仅切换 httpOnly 的当前部门 Cookie，服务端校验任用归属，不写业务数据",
  ],
  [
    "src/app/api/auth/[...nextauth]/route.ts::GET",
    "Auth.js 框架入口，认证链路自身负责身份校验",
  ],
  [
    "src/app/api/auth/[...nextauth]/route.ts::POST",
    "Auth.js 框架入口，认证链路自身负责身份校验",
  ],
  [
    "src/app/api/health/route.ts::GET",
    "公开就绪探针，供容器编排与负载均衡使用（P0）",
  ],
  [
    "src/app/api/health/live/route.ts::GET",
    "公开存活探针，不依赖数据库与身份（P0）",
  ],
]);

const FUNCTION_PATTERN = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
const ROUTE_CONST_PATTERN = /export\s+const\s*\{([^}]+)\}\s*=\s*handlers/g;
/**
 * 守卫入口：requirePermission / requireContextPermission / requireProtectedCapability，
 * 以及包装了守卫的领域助手（命名必须以 Permission / Capability 结尾，且内部调用前者）。
 */
const GUARD_CALL_PATTERN = /\brequire[A-Za-z]*(?:Permission|Capability)\s*\(/;

/**
 * 同一文件内的本地函数体：用于识别「多个导出入口共用同一个受守卫的包装函数」。
 * 例如审批中心的 approve / reject / cancel 都走 runDecision()（内部调用 requireContextPermission）。
 */
function collectLocalFunctions(source) {
  const map = new Map();
  const pattern = /(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const next = source.indexOf("\nexport ", start + match[0].length);
    map.set(match[1], source.slice(start, next === -1 ? source.length : next));
  }
  return map;
}

function isGuarded(body, locals, seen = new Set()) {
  if (GUARD_CALL_PATTERN.test(body)) {
    return true;
  }
  for (const [name, localBody] of locals) {
    if (seen.has(name)) {
      continue;
    }
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) {
      seen.add(name);
      if (isGuarded(localBody, locals, seen)) {
        return true;
      }
    }
  }
  return false;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function toKey(file, name) {
  const rel = relative(process.cwd(), file).split(sep).join("/");
  return `${rel}::${name}`;
}

function collectEntries(file, source) {
  const entries = [];

  for (const match of source.matchAll(FUNCTION_PATTERN)) {
    const name = match[1];
    const start = match.index ?? 0;
    const next = source.indexOf("\nexport ", start + match[0].length);
    const body = source.slice(start, next === -1 ? source.length : next);
    entries.push({ name, body });
  }

  for (const match of source.matchAll(ROUTE_CONST_PATTERN)) {
    for (const rawName of match[1].split(",")) {
      const name = rawName.trim();
      if (name) {
        entries.push({ name, body: "" });
      }
    }
  }

  return entries;
}

const files = walk(ROOT).filter(
  (file) => file.endsWith("actions.ts") || file.endsWith("route.ts"),
);

let total = 0;
let covered = 0;
const whitelisted = [];
const uncovered = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const locals = collectLocalFunctions(source);
  for (const entry of collectEntries(file, source)) {
    total += 1;
    const guarded = isGuarded(entry.body, locals);

    if (guarded) {
      covered += 1;
      continue;
    }

    const key = toKey(file, entry.name);
    if (WHITELIST.has(key)) {
      whitelisted.push(key);
      continue;
    }

    uncovered.push(key);
  }
}

for (const key of whitelisted) {
  console.log(`[SKIP] ${key} :: ${WHITELIST.get(key)}`);
}

if (uncovered.length > 0) {
  for (const key of uncovered) {
    console.error(`[FAIL] ${key} 未接入权限守卫`);
  }
  console.error(
    `\n[guards] files=${files.length} entries=${total} covered=${covered} whitelisted=${whitelisted.length} uncovered=${uncovered.length}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `\n[guards] files=${files.length} entries=${total} covered=${covered} whitelisted=${whitelisted.length} uncovered=0`,
  );
}
