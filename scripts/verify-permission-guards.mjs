/**
 * P4 守卫覆盖检查：扫描所有 Server Action 与 Route Handler。
 *
 * 规则：每个导出入口都必须调用 requireContextPermission() / requirePermission()，
 * 或调用「已受守卫的本地 / 跨文件助手」。跨文件追踪只沿本地导入（@/ 与相对路径），
 * 不做正则猜名字，避免把任意库调用当成守卫。
 *
 * 公开探针、认证框架入口、纯上下文切换与「仅靠 RLS 只读」的入口必须列入白名单并注明原因。
 *
 * 运行：npm run verify:guards
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd(), "src", "app");
const SRC_ROOT = resolve(process.cwd(), "src");

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
  [
    "src/app/(app)/knowledge/actions.ts::loadRunDetailAction",
    "只读入库批次详情：withUserContext + RLS 逐行判定，越权 0 行按不存在处理",
  ],
  [
    "src/app/(app)/knowledge/cards/actions.ts::loadEvidenceDocumentsAction",
    "只读证据候选文档：withUserContext + RLS 逐行过滤",
  ],
  [
    "src/app/(app)/knowledge/cards/actions.ts::loadEvidenceChunksAction",
    "只读证据候选切片：withUserContext + RLS 逐行过滤",
  ],
  [
    "src/app/api/knowledge/documents/[id]/route.ts::GET",
    "原始文件只读下载：RLS 校验可见性，越权与不存在统一 404",
  ],
  [
    "src/app/api/mcp/route.ts::POST",
    "MCP 端点：Bearer 令牌按 hash 反查并绑定在岗任用，工具 scope 与权限点均在工具内校验",
  ],
  [
    "src/app/api/mcp/route.ts::GET",
    "无状态 MCP 端点的非 POST 方法，固定返回 405，不读写数据",
  ],
  [
    "src/app/api/mcp/route.ts::DELETE",
    "无状态 MCP 端点不维护会话，固定返回 405，不读写数据",
  ],
  [
    "src/app/api/metrics/route.ts::GET",
    "只读聚合指标：SECURITY DEFINER 函数仅返回计数，无明细；配置 METRICS_TOKEN 时强制 Bearer 校验",
  ],
]);

const FUNCTION_PATTERN = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
const EXPORT_ARROW_PATTERN =
  /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/g;
const ROUTE_CONST_PATTERN = /export\s+const\s*\{([^}]+)\}\s*=\s*handlers/g;
const IMPORT_PATTERN = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
/**
 * 守卫入口：requirePermission / requireContextPermission / requireProtectedCapability，
 * 以及包装了守卫的领域助手（命名必须以 Permission / Capability 结尾，且内部调用前者）。
 */
const GUARD_CALL_PATTERN = /\brequire[A-Za-z]*(?:Permission|Capability)\s*\(/;
/** 直接抛 PermissionDeniedError 同样视为守卫（如 assertCanManage / L1-only 审批） */
const GUARD_THROW_PATTERN = /\bthrow\s+new\s+PermissionDeniedError\s*\(/;

const moduleCache = new Map();

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 解析 @/ 与相对路径；只认本地模块，外部包一律返回 null */
function resolveImport(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) {
    base = join(SRC_ROOT, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec);
  } else {
    return null;
  }

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 同一文件内的本地函数体：用于识别多个导出入口共用同一个受守卫的包装函数 */
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

function collectImports(source, file) {
  const map = new Map();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const target = resolveImport(match[2], file);
    if (!target) {
      continue;
    }
    for (const raw of match[1].split(",")) {
      const cleaned = raw.trim().replace(/^type\s+/, "");
      if (!cleaned) {
        continue;
      }
      const [original, local = original] = cleaned.split(/\s+as\s+/);
      map.set(local.trim(), { file: target, name: original.trim() });
    }
  }
  return map;
}

function collectExports(source) {
  const map = new Map();
  for (const pattern of [FUNCTION_PATTERN, EXPORT_ARROW_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      const next = source.indexOf("\nexport ", start + match[0].length);
      map.set(match[1], source.slice(start, next === -1 ? source.length : next));
    }
  }
  return map;
}

function loadModule(file) {
  if (moduleCache.has(file)) {
    return moduleCache.get(file);
  }
  const source = readFileSync(file, "utf8");
  const module = {
    file,
    source,
    locals: collectLocalFunctions(source),
    imports: collectImports(source, file),
    exports: collectExports(source),
  };
  moduleCache.set(file, module);
  return module;
}

function isGuarded(body, module, seen = new Set()) {
  if (GUARD_CALL_PATTERN.test(body) || GUARD_THROW_PATTERN.test(body)) {
    return true;
  }

  for (const [name, localBody] of module.locals) {
    if (seen.has(`local:${module.file}:${name}`)) {
      continue;
    }
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) {
      seen.add(`local:${module.file}:${name}`);
      if (isGuarded(localBody, module, seen)) {
        return true;
      }
    }
  }

  for (const [localName, target] of module.imports) {
    if (!new RegExp(`\\b${localName}\\s*\\(`).test(body)) {
      continue;
    }
    const key = `module:${target.file}:${target.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const targetModule = loadModule(target.file);
    const targetBody = targetModule.exports.get(target.name);
    if (targetBody && isGuarded(targetBody, targetModule, seen)) {
      return true;
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

function collectEntries(source) {
  const entries = [];

  for (const pattern of [FUNCTION_PATTERN, EXPORT_ARROW_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      const start = match.index ?? 0;
      const next = source.indexOf("\nexport ", start + match[0].length);
      entries.push({ name, body: source.slice(start, next === -1 ? source.length : next) });
    }
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
  const module = loadModule(file);
  for (const entry of collectEntries(source)) {
    total += 1;
    const guarded = isGuarded(entry.body, module);

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
