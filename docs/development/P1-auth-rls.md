# P1 组织治理与身份链路 · 开发过程记录

> 阶段：Phase 1（部门树 / 成员 / RLS / 会话）
> 日期：2026-10-30
> 状态：**代码已落地；自动化与浏览器验证已通过；待人工闸门确认**
> 依据：[master-plan.md](../architecture/master-plan.md) §4 Phase 1 / §5.1、[Milestone1-岗位与授权数据模型.md](../architecture/Milestone1-岗位与授权数据模型.md)

---

## 1. 结论摘要

| 交付项 | 状态 | 说明 |
|---|---|---|
| 部门树 / 闭包 / 成员 / 部门包表 | 已完成 | Drizzle schema + `0001_p1_org_departments.sql` |
| 闭包表触发器 | 已完成 | 全量锚点重建，按租户 advisory lock |
| RLS 函数与策略 | 已完成 | `db/policies/001–004`，migrate 每次重放 |
| SET LOCAL 身份注入 | 已完成 | `src/lib/db/user-context.ts`，每请求一个事务 |
| Auth.js v5 + Drizzle Adapter | 已完成 | Credentials + JWT，会话不手写 |
| 最小 audit_events（insert-only） | 已完成 | L1 可读，UPDATE/DELETE 已撤权 |
| 部门树 / 成员 / 我的权限 | 已完成 | 浏览器实测通过 |
| 越权测试（§5.1） | 已完成 | `npm run test:rls`：**18/18 PASS** |
| 人工闸门 | 待确认 | 见 [P1-gate.md](../gates/P1-gate.md) |

**结论**：身份链路已按「数据库为唯一权威」落地。L3 成员只能读自身部门；L2 可读子树；离岗后下一次请求立即 0 行；未注入身份返回 0 行而不是 500；应用连接为 `jxf_app`，非 superuser、非 bypassrls。

---

## 2. 关键决策（已获用户确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 认证库 | **Auth.js v5 + Drizzle Adapter** | 与 Next.js 15 / Drizzle 兼容性最好；会话签发交给成熟库 |
| 审计表 | **方案 A：P1 直接落地最小 `audit_events`** | 身份切换与越权拦截从第一天就具备审计追踪；保证 §5.1 第 5/6 条可验收 |
| 会话策略 | JWT（`maxAge` 8h） | Credentials Provider 的官方限制；权限不依赖 token，每请求重新解析任用 |
| 口令哈希 | Node 内置 scrypt | 不引入额外加密依赖，格式自带参数与盐 |

---

## 3. 数据模型与策略

### 3.1 表

| 表 | 用途 | RLS |
|---|---|---|
| `departments` | 部门 / 小组树（parent_id 自引用，无中间岗位层） | 启用 |
| `department_closure` | 子树闭包（ancestor → descendant, depth） | 启用，应用角色无任何策略 |
| `memberships` | 成员：department_id + 业务岗位 title + L1/L2/L3 + 离岗留痕 | 启用 |
| `department_packs` | 部门能力包（skill_ids / pipeline_ids 数组 + GIN） | 启用 |
| `audit_events` | 审计事件（insert-only） | 启用 |
| `users` | 身份主表：`phone` 唯一主账号，`email` 选填 | **不启用**（见 §5.2） |
| `user_email_identities` | 用户 ↔ 邮箱 1:N（为 CRM 多邮箱收发留位） | **不启用** |
| `accounts / sessions / verification_tokens` | Auth.js 身份表 | **不启用**（见 §5.2） |

迁移文件：`db/migrations/0001_p1_org_departments.sql`、`0002_p1_identity_phone.sql`（由 `drizzle-kit generate` 生成）。

> **三维解耦模型**：部门（层级 + 物理边界）／业务岗位（`memberships.title` 自由文本）／权限等级（`memberships.access_level` 独立选择）三者分离。成员直接挂在部门下，渲染为 `[等级徽章] 姓名 · 业务岗位`。
>
> **术语边界**：本文的「部门」指企业人员组织，不是 AI 员工。AI 员工不参与部门树、`department_closure` 与岗位数；它是 P2 引入基础 Schema、P3 完善运行态的独立实体，授权按岗位/人双粒度（Fail-Closed 绝对可见性），见 master-plan M2/M3。

### 3.2 闭包表

`db/policies/003_department_closure.sql`：

- 每个部门先写入 `(self, self, 0)`，再递归展开子部门；
- `AFTER INSERT OR UPDATE OR DELETE` 触发器按租户整棵重建；
- 事务级 `pg_advisory_xact_lock` 串行化同租户写入；
- 每次 migrate 重放策略时顺带重建一次，修复历史数据。

> **联调发现的缺陷**：原始 SQL 仅以 `parent_id is null` 作为递归锚点，闭包只包含「root → 所有节点」，导致下级读不到自身与下属。已改为「所有部门作为锚点」。

### 3.3 RLS 判定

```sql
-- 读：自身 + 子部门
app.can_read(department_id)  = exists (department_closure where ancestor = any(app.my_department_ids()))
-- 写：仅自身部门（改名 / 删除 / 能力包）
app.can_write(department_id) = department_id = any(app.my_department_ids())
```

- `app.user_department_ids(uuid)` / `app.effective_access_level(uuid)`：`SECURITY DEFINER`，只在请求入口调用一次；
- 策略内不 join `memberships`，避免逐行子查询；
- 未注入 `app.tenant_id / app.user_id` 时所有条件为 null，返回 0 行；
- `jxf_app` 非 owner / 非 superuser / 非 bypassrls。

部门创建（`departments_insert`）的判定是 **L1 + 租户匹配 + 上级部门 `app.can_read(parent_id)`**：L1 可在自己可读的子树任意节点下建部门；`can_write` 只用于「改 / 删自己部门」，不参与创建。

### 3.4 离职与最后 L1

`app.remove_membership(uuid)`（`SECURITY DEFINER`）：

1. 要求调用者 `access_level = 'L1'`；
2. 要求目标成员所在部门在调用者可读子树内；
3. 若目标是最后一个 L1 → `RAISE EXCEPTION`（`23514`），事务回滚；
4. 通过后写 `status='removed'` + `removed_at`。

`memberships` 的直接 `UPDATE / DELETE` 已从 `jxf_app` 撤销，只能走该函数。

### 3.5 审计

- 写：登录成功、部门创建/改名、成员添加/移除；
- 读：仅 L1；
- `UPDATE / DELETE / TRUNCATE` 从 `jxf_app` 撤销，insert-only；
- 业务写入与审计在同一事务（`auditInTx`）；登录审计独立事务，失败只记日志不阻断登录。

---

## 4. 身份链路

### 4.1 请求上下文

`src/lib/db/user-context.ts`：

```text
resolveUserContext(userId)
  → SELECT app.user_department_ids($1), app.effective_access_level($1)
  → withUserContext：BEGIN
      set_config('app.user_id', ..., true)
      set_config('app.tenant_id', ..., true)
      set_config('app.access_level', ..., true)
      set_config('app.department_ids', ..., true)
      业务查询
    COMMIT
```

- 不使用 `SET`，只用事务级 `SET LOCAL`（`set_config(..., true)`）；
- 每次请求重新解析任用，**离岗后同会话下一次请求立即 0 行**；
- 无任何任用：`access_level` 为空、`department_ids` 为空，读写全部 fail-closed。

新增环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `JXF_TENANT_ID` | 是 | 单租户 UUID；写入每个请求的 `app.tenant_id` |
| `SEED_PASSWORD` | 仅开发 | `npm run seed` 创建演示账号时使用；生产禁止设置 |

### 4.2 Auth.js

- `src/auth.ts`：Credentials Provider + Drizzle Adapter + JWT；
- 配置使用惰性函数 `NextAuth(() => buildAuthConfig())`，保证 `next build` 不要求运行期环境变量；
- 登录成功后写 `auth.login` 审计；
- `src/app/api/auth/[...nextauth]/route.ts` 暴露 handlers；
- 页面守卫在 `src/lib/auth/session.ts`：`requireSession()`，未登录跳 `/login`；
- 会话 Cookie：`authjs.session-token`，HttpOnly / SameSite=Lax / 8h。

### 4.3 UI（P1 切片）

| 路由 | 内容 |
|---|---|
| `/login` | 邮箱 + 密码，Auth.js 登录 |
| `/org/positions` | 部门树、成员名片（等级徽章 + 姓名 · 业务岗位）、新建/管理部门、添加/移出成员、最近审计（L1） |
| `/me/permissions` | 当前 `user_id / tenant_id / access_level / department_ids / request_id`、可见部门、审计 |

前端不做权限判断，只渲染数据库已授权结果。

**外壳与视觉（Apple 风格重构）**

- `src/components/shell/Shell.tsx` + `ProfileMenu.tsx`：纯文字 Logo 独立为品牌区（固定在侧栏/抽屉顶部，发丝底边与顶栏下边框对齐，高度 `3.5rem + 1px`）；导航项不使用背景胶囊，激活态仅为文字加粗 + 主色图标，导航区顶部留白 `0.75rem`；Profile（头像 + 名称 + 等级胶囊）固定在侧栏底部，点击向上弹出控制中心（设置 / 权限 / 审计 / 退出登录）；
- 搜索（Command Palette）：桌面搜索入口右对齐且与主卡片容器同宽（`72rem` + `2rem` padding），平板为缩短版（13rem、隐藏 ⌘K 键帽），手机收进抽屉顶部；点击或 `⌘K` / `Ctrl+K` 唤起 macOS 风格弹窗，当前提供「组织与岗位 / 我的权限 / 安全审计 / 系统状态」页面跳转，全文检索待 P3；
- 自适应（两套断点）：`≥1024px` 显示 15rem 毛玻璃侧栏（文字 Logo + 底部 Profile）；`<1024px` 隐藏固定侧栏，顶栏左侧纯文字 Logo（非链接）、右侧 ☰ 打开 80vw 毛玻璃抽屉（平板在 ☰ 左侧额外显示缩短搜索），抽屉内为「文字 Logo + 搜索 + 导航 + 底部 Profile 控制中心」；
- `src/app/globals.css`：根字号 `clamp(13px, 0.35vw + 10px, 16.5px)`，布局尺寸统一 rem 随根字号流式缩放；Apple 设计令牌（玻璃背景、圆角、柔和阴影、系统字体栈），卡片去灰描边，岗位类型徽章为低饱和胶囊；
- 搜索尚未接检索接口，提交时明示「P3 上线」，不伪造结果。

部门树渲染取「`parent_id` 为 null 或父节点不在可见集合内」的节点作为根，保证只可见自身部门的成员不会因父级不可见而渲染出空树。

成员名片格式为 `[等级徽章] 姓名 · 业务岗位`：L1 徽章显示「老板」（Apple Purple），L2 / L3 显示等级代号（Blue / Slate）。新建部门只要求选择上级部门（根部门由种子创建）；添加成员时业务岗位为自由文本 + 历史值建议（datalist），权限等级独立下拉。

### 4.4 写入链路

- 新增部门：应用侧 `randomUUID()` 显式生成 `id`，`INSERT` **不带 `RETURNING`**；
- 修改部门：`UPDATE ... WHERE id = $1`，`rowCount = 0` 视为无权限；
- 添加成员：邮箱 → `users` 查 id → 插 `memberships`（department_id / title / access_level，23505 转友好提示）；
- 移出成员：调用 `app.remove_membership($1)`；
- 所有写入均在同一事务内 `auditInTx` 落 `department.created / department.updated / membership.created / membership.removed`。

---

## 5. 验证结果

### 5.1 代码级

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；新增 `/login`、`/org/positions`、`/me/permissions`、`/api/auth/[...nextauth]` |
| 迁移应用 | `applied_migrations: 2`、`applied_policies: 4` |
| 闭包 | 种子租户 4 部门 → 8 条闭包；`delivery-1` 自身 + `east-team` 正确 |

### 5.2 RLS 越权测试（`npm run test:rls`）

```text
[PASS] L3 读兄弟部门
[PASS] L2 读自身部门与下级小组
[PASS] L3 读父部门
[PASS] L3 读兄弟部门成员
[PASS] 离岗用户 department_ids 为空
[PASS] 离岗用户读部门
[PASS] L3 读 audit_events
[PASS] L1 读 audit_events
[PASS] IDOR 显式传入他人 department_id
[PASS] 未注入身份读取
[PASS] L3 越权创建部门被拒绝
[PASS] L1 在子树内创建部门
[PASS] 删除最后一个 L1 被拒绝
[PASS] 移除 L3 后 department_ids 为空
[PASS] L1 删除子树内子部门
[PASS] 根节点不可删除
[PASS] 根节点不可改名
[PASS] 应用连接为 jxf_app 且非 superuser / 非 bypassrls

[RLS] passed=18 failed=0
```

覆盖 §5.1 十条（第 10 条由连接角色断言 + 部署配置保证）。

### 5.3 HTTP / 页面

| 检查 | 结果 |
|---|---|
| `GET /`（未登录） | 307 → `/login` |
| `GET /login` | 200 |
| `GET /org/positions`（未登录） | 307 → `/login` |
| `POST /api/auth/callback/credentials` | 302 + `authjs.session-token` |
| admin 登录后 `/org/positions` | 冷启动「老板」根节点 + 默认「销售部」、成员名片、新建/管理部门表单（无 slug，根节点不可改）、添加成员表单、审计可见 |
| 越权可见性（test:rls） | L3 只见自身部门；L2 见子树；移出后 0 行 |
| `/api/health` | 200（三扩展 + MinIO） |
| `GET /ai-employees`（旧路由） | 404，导航与页面内已无残留链接 |

浏览器实测（PASS）：登录 → 组织架构仅 1 个根节点「老板」 → 名片 `[老板] 张三 · 创始人` → 左侧新建/管理部门（无 slug）→ 右侧添加成员（手机号 / 选填邮箱 / 岗位 / L1-L3）→ 审计可见。

### 5.4 种子数据（仅开发）

`npm run seed` 创建冷启动组织：

- 账号：`admin@jxf.local` 张三（手机号 `13800000001`、老板 L1 / 创始人），并在 `user_email_identities` 写入主邮箱；
- 部门：根节点「老板」（slug `laoban`）＋默认子部门「销售部」（slug `xiao-shou-bu`），不含其他 Mock 部门或席位；
- 口令取 `SEED_PASSWORD`，生产禁止执行该脚本。

---

## 6. 实施中遇到的问题与处置

| 问题 | 原因 | 处置 |
|---|---|---|
| 下级读不到自身与下属 | 闭包递归锚点只取 root | 改为所有部门作为锚点；重放策略时重建闭包 |
| Drizzle Adapter 类型错误 | Postgres adapter 要求 accounts 使用 `refresh_token` 等 snake_case 属性名 | schema 属性名按 adapter 约定，DB 列名保持不变 |
| `next build` 无运行期 env | Auth 配置模块顶层调用 `loadEnv()` | 改为 `NextAuth(() => config)` 惰性构建 |
| JWT `token.uid` 类型不认识 | 模块扩展在回调中未收窄 | 使用 `typeof token.uid === "string"` 收窄 |
| 一次性迁移镜像需重建 | `db/` 被 COPY 进镜像 | 每次改 schema/policies 后重建 `jxf-ai/migrate` |
| 创建部门报错 | 创建策略要求 `can_write(parent)`，且 `INSERT ... RETURNING` 会触发新行的 SELECT 策略（闭包尚未更新） | 创建判定改为 `can_read(parent)`；应用侧生成 UUID 且不用 `RETURNING` |
| 部门树为空 | 树只从 `parent_id is null` 渲染，成员可见节点的父级不可见 | 改为「父不可见即视作根」渲染 |
| 岗位模型与真实组织不匹配 | 硬编码 `seat alpha/beta/gamma` 把「部门」和「岗位」混为一体，且权限等级绑在岗位上 | 重构为三维解耦：`departments` 部门树 + `memberships.title` 自由岗位 + `memberships.access_level` 独立等级；清空并重建 P1 基线迁移（未过闸门、无生产数据） |
| 路由与语义错位 | 岗位树挂在 `/ai-employees` | 路由改为 `/org/positions`，导航改为「组织与岗位」；AI 员工独立实体在 P2 建基础 Schema、P3 完善运行态 |
| 部门表单暴露 slug | slug 是隔离边界的实现细节，不该由人维护 | UI 移除 slug 输入；服务端按名称生成拼音（`pinyin-pro`），同父级重名追加 `-2` / `-3` |
| 账号以邮箱为主、种子含 Mock 部门 | 员工主账号是手机号；Mock 组织污染冷启动 | `users.phone` 唯一、`email` 选填，新增 `user_email_identities`（1:N）；种子只保留「老板」根节点 |
| 老板可被移出 / 根节点可删 | 缺少控制权保护 | L1 名片不渲染「移出」；`app.remove_membership` 拒绝移除最后一个 L1；`departments_delete` 要求 `parent_id is not null` |

---

## 7. 避坑与注意事项

1. **不要给 `jxf_app` 任何 owner / superuser / bypassrls 权限**，否则 RLS 静默失效。
2. `db/policies/*.sql` 每次 `up` 都会重放，新增策略必须幂等；不要写不可重复执行的 DDL。
3. 业务写入必须走 `withUserContext`，不要直接用 `getPool().query` 操作业务表。
4. `memberships` 的 UPDATE / DELETE 已撤权，离岗统一走 `app.remove_membership()`。
5. `department_closure` 对应用角色完全不可见（无策略 + 撤权），只能通过 `SECURITY DEFINER` 函数使用。
6. Auth.js Credentials 只能配 JWT 会话；不要尝试改成 database session。
7. Auth.js 身份表（users/accounts/sessions）未启用 RLS：登录发生在身份建立之前，无法按 `app.user_id` 过滤；它们不承载业务数据，后续若引入多租户需单独设计。
8. 种子口令只从 `SEED_PASSWORD` 读取，禁止把开发口令写进仓库或生产环境。
9. P1 UI 的错误提示仍由 Next error boundary 承担；P2 起改为表单级错误反馈。
10. **不要对 RLS 表使用 `INSERT ... RETURNING`**：`RETURNING` 会套用该行的 `SELECT` 策略，闭包未更新前新节点不可读，写入会失败。用应用侧 UUID + 事后查询。
11. 新增部门不要用数据库默认值依赖 `RETURNING` 回填 `id`；`id` 由应用生成，跨层一致。
12. 「岗位」是成员属性（`memberships.title`），不要再建中间层节点；部门才是权限与 RAG 的物理边界。

---

## 8. P2 接手事项

1. **复用同一套 RLS 模式**：`assets / documents / doc_chunks / knowledge_cards / card_evidence / ingest_*` 全部按 `department_id + tenant_id` 建策略，不另立机制。
2. **检索必须先显式 `department_id = any()` 再 RLS 兜底**，避免索引后过滤导致召回下降。
3. `pg_bigm` / `pgvector` 已在 P0 验证可用；P2 直接建 `vector` 列与 `tsv`。
4. 引用校验、确认门槛（`v_confirmable_cards`）放数据库视图/函数，UI 只调用 action。
5. 上传与解析：原件入 MinIO（P0 已就绪），解析与写库仍由 TS 在用户上下文内完成。
6. 审计继续使用 `audit_events`，新增动作时保持 insert-only。
7. 不要绕过 `withUserContext`；P2 的批量入库也要在事务内注入身份。

---

## 9. 交付物

| 文件 | 说明 |
|---|---|
| `db/schema/*.ts` | departments / department_closure / memberships / department_packs / audit / auth 表定义 |
| `db/migrations/0001_p1_org_departments.sql` | P1 表结构基线（部门模型） |
| `db/policies/001_app_functions.sql` | 身份上下文与授权函数 |
| `db/policies/002_rls_policies.sql` | 业务表 RLS 策略 |
| `db/policies/003_department_closure.sql` | 闭包触发器与重建 |
| `db/policies/004_audit.sql` | 审计 insert-only 策略与撤权 |
| `db/seed/dev.ts` | 最小部门树、成员与演示账号 |
| `src/auth.ts` / `src/types/next-auth.d.ts` | Auth.js 配置与类型扩展 |
| `src/lib/auth/*` | 口令、会话、登出 |
| `src/lib/db/user-context.ts` | SET LOCAL 注入与事务封装 |
| `src/lib/audit.ts` | 事务内 / 独立审计写入 |
| `src/app/(app)/**`、`src/app/login/page.tsx` | 部门树与权限调试页 |
| `scripts/test-rls.mjs` | §5.1 越权测试 |

---

## 10. 闸门状态

**自动化与浏览器验证通过，待人工闸门确认。**

- 通过条件：用户按 [P1-gate.md](../gates/P1-gate.md) 在浏览器逐条操作确认；
- 通过后打 tag `gate/p1-passed`，再进入 P2；
- 未通过前，不开始 P2 的任何代码。
