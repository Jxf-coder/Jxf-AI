# 权限系统与 UI 落地实施计划

> 项目：Jxf-AI 私有化交付工作台
> 范围：L1–L3 防越权底线 + 细粒度 PermissionNode + Scope + Pending Handover 审批流
> 版本：v1.1（范围裁剪稿）
> 日期：2026-11-02
> 状态：待评审确认后进入 P0/P1 编码
> 本轮变更：按架构评审做「减法」，暂不纳入财务与经营、教学与教务、市场投放（CRM）三类权限点，仅保留扩展接口。
> 关联文档：[原项目权限体系分析报告](./原项目权限体系分析报告.md)、[master-plan.md](./master-plan.md)

---

## 目录

- [〇、本轮范围裁剪（减法）](#〇本轮范围裁剪减法)
- [一、已确认的 6 条语义](#一已确认的-6-条语义)
- [二、目标架构与不可动摇的约束](#二目标架构与不可动摇的约束)
- [三、阶段总览](#三阶段总览)
- [四、各阶段详述](#四各阶段详述)
- [五、数据模型与迁移清单](#五数据模型与迁移清单)
- [六、UI 页面清单](#六ui-页面清单)
- [七、测试与验收矩阵](#七测试与验收矩阵)
- [八、风险与回滚](#八风险与回滚)
- [九、工程约束](#九工程约束)
- [十、第一阶段启动包](#十第一阶段启动包)

---

## 〇、本轮范围裁剪（减法）

### 0.1 纳入本轮权限系统的模块

| 模块 | 典型节点 | 说明 |
|---|---|---|
| 成员管理 | `member:view / manage / level / ssh` | 组织内人员与任用 |
| 组织架构 | `org:view / manage / grant` | 部门树、岗位挂载 |
| Skill / 技能库 | `skill:use / edit / publish / create` | 技能使用与发布 |
| 产线 / 自动化 | `pipeline:use / manage` | 自动化产线运行与配置 |
| 知识库 | `knowledge:read / write / confirm / export` | 知识卡、巡读、交接包 |
| MCP 令牌 | `token:issue / revoke` | 外部客户端授权 |
| 审计 | `audit:read` | 组织与权限变更记录 |
| 平台设置 | `platform:settings / tenant` | 系统级配置（保护区另列） |
| 个人资料 | `profile:view_self / edit_self` | 本人资料维护 |

### 0.2 本轮明确不纳入的模块

| 模块 | 处理方式 |
|---|---|
| 财务与经营 | 不定义权限节点、不出现在配置面板、不接守卫；后续按扩展接口接入 |
| 教学与教务 | 同上 |
| 市场投放 / CRM / 广告 | 同上；资产适配器保留空实现，不注册 |
| 财务 / 教学 / 投放相关的 Skill 分类 | 继续由现有业务逻辑控制，不进入本轮权限目录 |

> 说明：不纳入不等于删除代码。现有页面、代理层与外部接口保持原状，只是**不纳入本次权限点体系与验收范围**，并在守卫覆盖脚本中列入白名单、标注 `deferred`。

### 0.3 为后续保留的扩展接口

保证后期接入三大板块时**不改核心表结构、不改判定主流程**：

1. **Key 命名空间预留**：`finance:*`、`teaching:*`、`crm:*`、`ads:*` 保留，不在本轮创建节点。
2. **模块注册表**：`catalog.ts` 中用 `PermissionModule` 描述模块（`key / nameZh / enabled / order`），配置面板按 `enabled` 过滤；新增模块只加一行注册，不改 UI 主体。
3. **判定接口通用**：`authorize(key, resource)` 与 `requirePermission(key, loader?)` 不感知具体模块；新增模块只加目录与守卫。
4. **资产适配器注册表**：`AssetAdapter` 接口保留，v1 只注册 `agent / knowledge`；`crm_task` 等后续注册即可。
5. **审批类型可扩展**：`approval_requests.type` 为文本，后续可增加 `finance_export`、`ads_publish` 等类型，不改表结构。
6. **UI 分页可扩展**：权限管理面板按模块渲染，不写死模块列表；新增模块自动出现。

### 0.4 减法带来的计划调整

| 原计划 | 调整后 |
|---|---|
| 权限目录 40–60 个 | 约 30–40 个（仅核心模块） |
| P0 目录包含财务/教学/投放 | 移除；仅保留命名空间与模块注册位 |
| P4 收紧财务/教学代理 | 本轮不做，列入 `deferred` 白名单 |
| P7 注册 `crm_task` 适配器 | 不注册；仅保留接口与空实现 |
| 测试覆盖财务/教学/投放 | 改为覆盖"未启用模块不出现在目录/面板" |

---

## 一、已确认的 6 条语义

| # | 议题 | 最终结论 |
|---|---|---|
| 1 | DEPT 边界 | 读 = 本部门 + 全部直属子部门（DEPT_TREE）；写 = 严格本部门（DEPT）。子部门写权限归子部门 L2，除非 L1 介入或走越级申请。 |
| 2 | 多部门任用 | 按任用分别计算（Contextual Scope）。不取全局最高等级，不合并部门；当前操作上下文决定加载哪条任用的等级与权限。 |
| 3 | L1 默认权限 | L1 自动拥有全部非保护区权限，无需显式勾选；保护区例外，硬编码绑定 L1。 |
| 4 | Pending Handover 账号状态 | 禁止登录、会话立即失效、完全冻结；L1 可随时撤回移出申请；交接完成后才流转为 Deactivated。 |
| 5 | 唯一 L1 | L1 自己发起移出时系统阻断，要求先转让 L1；系统级硬编码禁止删除/停用最后一个 L1。 |
| 6 | 新权限点默认值 | 默认全部关闭，由角色模板或 L1 显式开启；高危节点永远默认关闭且不可逆，必须 L1 授权。 |

### 1.1 由上述语义推导出的硬规则

1. `effective ⊆ ceiling(level)`：任何勾选都不能突破等级上限。
2. 写类动作的 Scope 只能是 `DEPT` 或 `SELF`，不能是 `DEPT_TREE`。
3. 多任用按"当前部门上下文"解析，绝不全局合并。
4. `deny` 覆盖 `allow`；未知节点默认拒绝。
5. 最后一个 L1 不可移出、不可停用、不可降级。
6. 保护区节点不出现在任何配置面板，且不可被授权覆盖。
7. Pending Handover 账号无法登录、无法调用任何写接口。

---

## 二、目标架构与不可动摇的约束

### 2.1 判定公式

```text
effective(actor, node, resource) =
  ceiling(activeMembership.level)
  ∩ grants(allow)
  − grants(deny)
  ∩ scope(activeDepartment, resource.department_id)

若 node.protected → 仅 level === "L1" 且硬编码通过
若 node 需要审批 → 生成 approval_request，不直接执行
否则默认拒绝
```

### 2.2 四个"单一真相源"

| 真相 | 唯一来源 | 不允许出现 |
|---|---|---|
| 权限目录 | `src/lib/permissions/catalog.ts` | DB 里再维护一份手工目录 |
| 当前上下文 | 服务端 `resolveUserContext()` | 客户端传 `departmentId` 直接当作用域 |
| 判定入口 | `authorize()` / `requirePermission()` | 页面里手写 `if (level === 'L2')` |
| 授权变更 | `user_permission_grants` + 审计 | 只改前端状态、不落库 |

### 2.3 三层职责分离

| 维度 | 回答什么 | 不能做什么 |
|---|---|---|
| `L1/L2/L3` | 最多能拿到多高的权限 | 不能等价于某组 PermissionNode |
| `PermissionNode` | 能执行什么动作 | 不能自带数据范围 |
| `Scope(ALL/DEPT_TREE/DEPT/SELF)` | 动作能落在哪些数据上 | 不能替代资源归属校验 |

### 2.4 保护区（硬编码，不进目录）

- 密钥 / Secret 管理
- 根账号管理
- 最后一位 L1 保护
- 权限授权本身（`permission:grant`）
- 系统级平台配置（租户、升级、部署密钥）
- 代码保护区路径

---

## 三、阶段总览

| 阶段 | 目标 | 主要产出 | 依赖 |
|---|---|---|---|
| P0 | 语义与目录冻结 | `permission-model.md` + `catalog.ts` 草案 | 无 |
| P1 | 数据与类型底座 | 迁移、表、TS 类型、回填 | P0 |
| P2 | 服务端鉴权核心 | `resolve / authorize / grant / guard` + 单测 | P1 |
| P3 | 上下文与作用域修复 | 单部门上下文、RLS 函数改造 | P2 |
| P4 | API / Server Action 守卫 | 全量接入 + 守卫覆盖检查 | P3 |
| P5 | 前端 Hook 与现有页面接入 | Provider、`usePermission`、按钮/导航 | P4 |
| P6 | 权限管理面板 | 角色模板、成员授权、变更记录 | P5 |
| P7 | Pending Handover 与审批中心 | 状态机、资产适配器、审批页 | P6 |
| P8 | 收尾与验收 | 测试矩阵、文档、部署、回滚 | P7 |

> 严格按顺序推进；P3 不完成不要进 P5，否则前端会围绕错误的作用域模型写。

---

## 四、各阶段详述

### P0 · 语义冻结与权限目录

**核心任务**

1. 编写 `docs/architecture/permission-model.md`，固定 6 条语义、判定公式、Scope 定义、保护区清单、审批规则。
2. 在 `src/lib/permissions/catalog.ts` 定义 `PermissionNode` 元数据：
   - `key`、`module`、`nameZh`、`description`、`riskLevel`、`defaultEnabled`、`protected`、`grantable`、`requiresApproval`、`impliedBy`。
3. 冻结第一批目录，控制在 30–40 个，按模块分组（仅本轮启用模块）：
   - 成员、组织、Skill、产线、知识、令牌、审计、平台设置、个人资料。
   - 财务、教学、投放不创建节点，只保留 `finance:* / teaching:* / crm:* / ads:*` 命名空间。
4. 定义 Scope 枚举：`ALL | DEPT_TREE | DEPT | SELF`，明确每种适用于哪些动作。
5. 列出"现有宽松点清单"，作为 P4 收紧项：
   - `department_packs` 的 UPDATE/DELETE 目前只校验 `can_write`。
   - 知识卡确认/删除无管理员限制。
   - 财务/教学代理层只校验登录：**本轮不处理，列入 deferred 白名单**。

**涉及文件**

- `docs/architecture/permission-model.md`（新建）
- `src/lib/permissions/catalog.ts`（新建）
- `src/lib/permissions/scope.ts`（新建）

**技术难点**

- 目录粒度容易失控：规定"一个模块最多 4–6 个节点"，高危动作（publish/ship/approve/export）单独列。
- 隐含关系不要靠命名猜：`skill:publish` 是否隐含 `skill:edit` 必须显式写 `impliedBy`。
- 模块必须可开关：目录里维护 `PermissionModule.enabled`；未启用模块的节点不参与解析、不出现在面板，避免后期接入时改 UI 主体。

**验收**

- 目录评审通过，每个节点都有中文名、风险级、默认值、是否可授予。
- 能回答"这个按钮对应哪个节点、需要什么 Scope"。
- 财务/教学/投放模块 `enabled=false`，节点数为 0。

---

### P1 · 数据与类型底座

**核心任务**

1. 新增表：
   - `role_templates`
   - `role_template_grants`
   - `user_permission_grants`
   - `permission_revisions`
2. 扩展 `users.status`：`active | pending_handover | disabled`。
3. 扩展 `membership_status`：增加 `pending_removal`。
4. 新增审批表：
   - `approval_requests`
   - `handover_items`
5. 生成 Drizzle schema 与迁移：
   - `db/schema/permission-grants.ts`
   - `db/schema/approvals.ts`
   - `db/migrations/0005_permissions.sql`
   - `db/migrations/0006_pending_handover.sql`
   - 更新 `db/schema/index.ts`、`db/migrations/meta/*`、`_journal.json`
6. 回填（仅本轮启用模块）：
   - 所有 `L1` → 全量非保护区授权。
   - `L2` → 读子树 / 写本部门模板。
   - `L3` → 基础模板（默认 `SELF`）。
   - 财务 / 教学 / 投放不生成任何授权行。
7. 修正历史数据：多任用用户不合并权限，只建立模板与上下文选择能力。

**涉及文件**

- `db/schema/permission-grants.ts`
- `db/schema/approvals.ts`
- `db/schema/index.ts`
- `db/migrations/0005_permissions.sql`
- `db/migrations/0006_pending_handover.sql`
- `db/migrations/meta/0005_snapshot.json`
- `db/migrations/meta/0006_snapshot.json`
- `db/migrations/meta/_journal.json`
- `db/policies/010_permission_grants.sql`（新建）
- `db/policies/011_handover_approval.sql`（新建）
- `src/types/permission.ts`（新建）

**技术难点**

- **PostgreSQL 枚举加值**：`ALTER TYPE membership_status ADD VALUE 'pending_removal'` 不能与"立即使用该值"放在同一事务；迁移容器会包事务，建议拆成独立迁移，或把新状态改成 `text + check`。
- **快照文件手工维护**：新增两张表容易漏索引/约束；先用 `drizzle-kit generate`，再人工核对。
- **回填幂等**：迁移会被重复执行，必须写全 `insert ... on conflict do nothing`。
- **行为变化**：现在 L2 可以改子部门 L3 的资料，新规则"写仅本部门"会收紧；需要显式标注为有意变更。

**验收**

- 空库可迁移；已有库可重复迁移不报错。
- 回填后 L1/L2/L3 的默认行为与现有页面基本一致，差异项有清单。

---

### P2 · 服务端鉴权核心

**核心任务**

1. `ceiling.ts`：`level → Set<PermissionKey>`，L1 全量（保护区除外）。
2. `resolve.ts`：
   - 输入：`userId + activeMembership`。
   - 输出：`{ level, departmentId, grants: Map<key, scope>, denies: Set<key>, version }`。
   - 合并顺序：模板 → 用户授权 → deny。
3. `authorize.ts`：
   - `authorize(actor, key, resource?) → { allowed, reason, requiredScope }`。
   - 资源必须传"已从 DB 读出的行"，不能传客户端参数。
4. `grant.ts`：
   - `canGrant(actor, targetUserId, key, scope)`：校验授权上限、目标等级上限、Scope 上限、高危节点仅 L1。
5. `guard.ts`：
   - `requirePermission(key, resourceLoader?)`：抛标准化 `PermissionDeniedError`（403），对外不泄露资源是否存在。
6. 单测：
   - 7 条不变量逐条覆盖。
   - 多任用、deny 优先、未知节点、保护区、L1 全量。

**涉及文件**

- `src/lib/permissions/ceiling.ts`
- `src/lib/permissions/resolve.ts`
- `src/lib/permissions/authorize.ts`
- `src/lib/permissions/grant.ts`
- `src/lib/permissions/guard.ts`
- `src/lib/permissions/__tests__/*` 或 `scripts/test-permissions.mjs`

**技术难点**

- **避免 N+1**：一次查询把 memberships + grants + template 全部取回，在内存里合并。
- **reason 设计**：前端要能显示"缺哪个节点 / Scope 不够 / 被 deny"，不能只返回 boolean。
- **资源加载器**：`requirePermission` 建议接受 `resourceLoader`，由 guard 内部读取并判权，避免调用方漏查。
- **与 RLS 同源**：`resolve()` 的 `(level, departmentId)` 必须就是写进 `SET LOCAL` 的那一份。

**验收**

- 纯函数单测全绿；不需要数据库即可验证核心规则。
- 任意节点都能给出可读拒绝原因。

---

### P3 · 上下文与作用域修复（最关键的一步）

**核心任务**

1. 引入"当前部门上下文"：
   - 用户只有一条有效任用 → 自动选中。
   - 多条 → 服务端从 cookie `jxf_dept` 读取并校验；无效则回落到主部门。
   - 所有页面、Server Action 统一从 `resolveUserContext()` 取，不从 URL/表单取。
2. 改造 `src/lib/db/user-context.ts`：
   - `accessLevel` 改为"当前任用等级"。
   - `departmentIds` 改为"当前部门 + 子树"（由闭包函数提供），不再返回全部任用部门。
   - 增加 `activeMembershipId`、`activeDepartmentId`、`permissionVersion`。
3. 改造 SQL 函数 `db/policies/001_app_functions.sql`：
   - `app.user_department_ids(user, active_dept)` 或新增 `app.active_department_ids()`。
   - `app.effective_access_level(user, active_dept)`。
   - 新增 `app.has_active_membership(user)` 供登录校验。
4. 调整 RLS：
   - 读：闭包子树（`DEPT_TREE`）。
   - 写：仅 `DEPT`。
   - `memberships` 自身仍允许本人读。
5. 登录链路：
   - `authorize` 拒绝 `users.status != 'active'`。
   - `requireSession` / `resolveUserContext` 每请求校验状态，Pending Handover 立即失效。
6. 前端增加部门切换器（`Shell`），只有多任用用户可见。

**涉及文件**

- `src/lib/db/user-context.ts`
- `src/lib/auth/session.ts`
- `src/auth.ts`
- `db/policies/001_app_functions.sql`
- `db/policies/002_rls_policies.sql`
- `db/policies/009_audit_scope.sql`
- `src/components/shell/Shell.tsx`
- `src/app/(app)/layout.tsx`
- `scripts/test-rls.mjs`

**技术难点**

- **破坏性变更**：所有依赖 `context.departmentIds` 的页面都要重新审视：`OrgTree`、`ProfilePage`、`AuditPage`。
- **RLS 递归**：新增函数继续用 `SECURITY DEFINER`，不要放开 `memberships` 整表权限。
- **登录与"无任用"语义**：Pending Handover 不能仅靠"没有 active membership"判断，因为用户可能还有其他部门任用；必须看 `users.status`。
- **审计归属**：`audit_events.department_id` 写"当前上下文部门"，不是用户的全部部门。
- **缓存**：部门切换后必须让 RSC/路由缓存失效。

**验收**

- 多任用测试：A 部门 L3 + B 部门 L2，在 A 上下文下只有 L3 能力，且写不到 B。
- Pending Handover 用户：登录被拒、已有会话下一次请求失效。
- 现有 RLS 测试全部通过，并新增多任用与 Pending 用例。

---

### P4 · API / Server Action 守卫接入

**核心任务**

1. 盘点所有写入口：
   - `src/app/**/actions.ts`
   - `src/app/api/**/route.ts`
2. 每个入口增加 `requirePermission()`，统一错误返回：
   - Server Action：`{ ok: false, message }`
   - Route Handler：403 JSON，不泄露存在性。
3. 收紧历史宽松点（P0 清单）：
   - `department_packs` 写操作
   - 知识卡确认/删除
   - 财务/教学代理层：**本轮不接守卫**，在覆盖脚本中列为 `deferred`，后续接入时再补
4. **影子模式**：先只计算、记录与旧判定差异，不立即拒绝；差异清零后再启用强制。
5. 新增守卫覆盖检查脚本：扫描所有导出 action/route，未出现 `requirePermission` 的列入白名单并注明原因。

**涉及文件**

- `src/app/(app)/org/positions/actions.ts`
- `src/app/(app)/me/profile/actions.ts`
- `src/app/(app)/me/profile/page.tsx`
- `src/app/(app)/me/audit/page.tsx`
- `src/app/(app)/me/permissions/page.tsx`
- 所有 `src/app/api/**/route.ts`（财务/教学/投放相关代理标记 `deferred`，本轮不接守卫）
- `scripts/verify-permission-guards.mjs`（新建）

**技术难点**

- **Guard 签名统一**：不同资源需要不同 loader；建议 `requirePermission(key, { type, id })` + 内部 registry 解析。
- **404 vs 403**：对无权访问的资源返回 404，避免探测存在性；对"有读无写"返回 403。
- **事务内判定**：权限判定与业务写入应在同一事务，避免判定后被并发改权限。
- **影子模式噪音**：差异日志要带 `userId / key / resource / oldResult / newResult`。

**验收**

- 守卫覆盖脚本 0 未覆盖（白名单除外）。
- 影子模式运行后差异清单评审完毕。
- 每个写入口都有越权测试。

---

### P5 · 前端 Hook 与现有页面接入

**核心任务**

1. 服务端 `layout.tsx` 注入 `<PermissionProvider>`：
   - 快照：`version / level / activeDepartmentId / grants / denies / protectedKeys`。
   - 只下发"允许的 key + scope"，不下发完整目录。
2. `usePermission()`：
   - `can(key, scope?) → boolean`
   - `check(key, scope?) → { allowed, reason }`
   - 只读快照，不发请求。
3. `<Can permission="..." scope="...">` 组件。
4. 替换现有粗粒度布尔：
   - `OrgTree` 的 `canManage`
   - `ProfilePermissions` 的 `canEditCore / canEditTitle / canEditOrg`（保留为派生视图，底层调用 `can()`）
   - 导航/命令面板的入口显隐
5. UI 三态规范：
   - 模块无权限 → 隐藏入口。
   - 有查看无操作 → 禁用按钮 + tooltip 原因。
   - 高危动作 → 禁用 + "需 L1 授权/审批"说明。
6. 缓存失效：
   - 授权变更后 `revalidateTag('perm:<userId>')`。
   - 必要时 `router.refresh()`，避免旧按钮残留。

**涉及文件**

- `src/components/permissions/PermissionProvider.tsx`（新建）
- `src/components/permissions/usePermission.ts`（新建）
- `src/components/permissions/Can.tsx`（新建）
- `src/app/(app)/layout.tsx`
- `src/app/(app)/org/positions/OrgTree.tsx`
- `src/app/(app)/org/positions/page.tsx`
- `src/app/(app)/me/profile/ProfileClient.tsx`
- `src/app/(app)/me/profile/page.tsx`
- `src/components/shell/Shell.tsx`
- `src/components/shell/ProfileMenu.tsx`
- `src/components/shell/CommandPalette.tsx`
- `src/app/globals.css`

**技术难点**

- **快照大小与序列化**：本轮 30–40 个 key 没问题，但不要把目录、中文名、描述都传客户端。
- **Hydration**：服务端禁用、客户端又启用会造成闪烁；快照必须由服务端一次注入。
- **客户端 Scope 只是近似**：按钮可用不代表服务端一定放行（资源归属要查库），接受"点了才报无权限"的兜底。
- **Layout 缓存**：权限变更后 layout 可能不刷新，必须配合 tag 失效。
- **多标签页**：Provider 带 `version`，轻量轮询或 `BroadcastChannel`。

**验收**

- 权限变更后下一次请求生效。
- 无权限按钮不出现或禁用且原因可读。
- 全仓 grep 无新增 `level === "L2"` 之类的散落判断。

---

### P6 · 权限管理面板

**核心任务**

1. 新页面 `/settings/permissions`（仅 L1）：
   - Tab 1：角色模板（L1/L2/L3 默认节点与 Scope，仅显示已启用模块）。
   - Tab 2：成员授权（选择成员 → 模块分组 → 勾选节点 + Scope）。
   - Tab 3：变更记录（谁在何时改了谁的什么）。
   - 模块列表来自 `PermissionModule` 注册表，不写死；`enabled=false` 的模块（财务/教学/投放）不渲染。
2. 交互：
   - 搜索、按模块折叠、全选/清空。
   - 显示"相对模板的 diff"。
   - 保存前预览"该成员最终有效权限"。
   - 未保存离开提示。
3. 授权保存：
   - 服务端 `canGrant()` 二次校验。
   - 同一事务写 `user_permission_grants` + `permission_revisions` + `audit_events`。
4. 改造 `/me/permissions`：
   - 从"调试页"变成"我的有效权限"：节点、Scope、来源（模板/个人）、拒绝原因。
   - 调试上下文信息折叠保留。
5. v1 只允许 L1 编辑授权；L2 的授权能力留到后续，并受 grant ceiling 限制。

**涉及文件**

- `src/app/(app)/settings/permissions/page.tsx`（新建）
- `src/app/(app)/settings/permissions/PermissionAdminClient.tsx`（新建）
- `src/app/(app)/settings/permissions/actions.ts`（新建）
- `src/app/(app)/me/permissions/page.tsx`（重写）
- `src/lib/permissions/catalog.ts`
- `src/app/globals.css`

**技术难点**

- **矩阵 UI 复杂度**：30–40 个节点 × 4 种 Scope，必须分组 + 折叠 + 搜索，不做全量平铺。
- **Scope 可理解性**：`ALL / DEPT_TREE / DEPT / SELF` 需要中文解释与示例。
- **保存粒度**：按成员整体保存，而不是每个 checkbox 即时保存，减少并发与审计噪音。
- **并发编辑**：两个人同时改同一成员，需要 `permission_revisions.version` 做乐观锁。
- **高危节点**：`protected` 节点不展示；`requiresApproval` 节点展示但标注"需审批"。

**验收**

- L1 能给成员勾选并在下一次请求生效。
- 不能勾出超过等级上限的组合（UI 禁用 + 服务端拒绝）。
- 每次变更都有审计与 diff。

---

### P7 · Pending Handover 与审批中心

**核心任务**

1. 移出流程改造：
   - `checkMemberBlockers` 返回按资产类型分组的明细。
   - 有资产 → 打开交接向导：逐类选择接收人（默认同部门 L3/L2）。
   - 创建 `approval_requests(type='membership_removal')` + `handover_items`。
   - 成员状态 `active → pending_removal`；`users.status → pending_handover`；会话立即失效。
2. 审批中心 `/me/approvals`：
   - L1 看到待审批列表、资产明细、接收人。
   - 通过：单事务内锁定资产 → 转移 → 成员 `removed` → 用户 `disabled` → 审计。
   - 驳回：成员恢复 `active`、用户恢复 `active`、审批关闭。
   - 撤回：L1 可随时撤回，状态回滚。
3. 资产适配器：
   - `AssetAdapter { listBlocking, transfer, archive }`。
   - v1 只注册 `agent / knowledge`（对应表未建时返回 0，接口先就位）。
   - `crm_task` 等投放/财务/教学类资产保留空实现，**本轮不注册**。
4. 消息入口：
   - 顶栏铃铛 + 待审批数量；不新建独立消息系统。
5. 并发与幂等：
   - `unique(membership_id) where status='pending_approval'`。
   - 资产行 `for update`。
   - 审批操作带 `request_id` 幂等键。
6. 唯一 L1：
   - 移出 L1 时直接拒绝，提示先转让 L1。
   - 数据库函数继续保留"最后一位 L1"保护，应用层与数据库双保险。

**涉及文件**

- `src/app/(app)/org/positions/actions.ts`
- `src/app/(app)/org/positions/OrgTree.tsx`
- `src/app/(app)/me/approvals/page.tsx`（新建）
- `src/app/(app)/me/approvals/actions.ts`（新建）
- `src/lib/handover/adapters.ts`（新建）
- `src/lib/handover/registry.ts`（新建）
- `db/policies/011_handover_approval.sql`
- `db/schema/approvals.ts`
- `src/components/shell/Shell.tsx`
- `src/lib/audit.ts`

**技术难点**

- **TOCTOU**：审批期间必须禁止该用户新建资产；成员 `pending_removal` 状态要参与所有写接口判定。
- **登录失效**：不能只靠"没有 active membership"，多任用用户可能还有其他部门任用；必须看 `users.status`。
- **自审批**：L1 发起移出时，若系统只有一位 L1，建议"确认即通过 + 留痕"或"要求第二位 L1"；v1 采用"L1 二次确认 + 审计"，避免流程死锁。
- **交接目标越界**：接收人必须在操作者写作用域内；跨部门交接需要 L1 显式确认。
- **部分失败**：全部资产在一个事务内转移；数量大时分批 + 补偿，不要长事务锁表。
- **资产表未建**：M2/M3 未落地前适配器返回 0，不能因此绕过接口设计。

**验收**

- 有资产成员移出 → 立即锁定 → L1 审批 → 资产全部转移 → 正式停用。
- 驳回/撤回可恢复原状。
- 全程审计可追溯，交接幂等。

---

### P8 · 收尾与验收

**核心任务**

1. 测试：
   - 单元：ceiling / scope / deny / grant / 保护区。
   - 集成：RLS 多任用、Pending Handover、L2 写仅本部门、L3 仅本人。
   - 脚本：守卫覆盖率、迁移幂等。
2. 文档：
   - `docs/architecture/permission-model.md` 定稿。
   - `docs/development/P1-progress.md` 追加本轮记录。
   - 权限目录变更流程（新增/废弃/重命名）。
3. 部署：
   - `docker compose build migrate web` → `up -d --no-build`。
   - 迁移失败回滚脚本。
4. Git：
   - 每个阶段一个可回溯 commit；不混阶段。
5. 观测：
   - 权限拒绝日志带 `user / key / resource / reason`。
   - 影子模式差异归零。

**涉及文件**

- `scripts/test-permissions.mjs`（新建）
- `scripts/test-rls.mjs`（扩展）
- `scripts/verify-permission-guards.mjs`
- `docs/architecture/permission-model.md`
- `docs/development/P1-progress.md`
- `docker/*`

---

## 五、数据模型与迁移清单

### 5.1 新增表

```text
role_templates            (id, name, level, is_system)
role_template_grants      (template_id, permission_key, scope_type, effect)
user_permission_grants    (id, tenant_id, user_id, permission_key, scope_type, scope_id,
                           effect, granted_by, expires_at, created_at, updated_at)
permission_revisions      (user_id, version, updated_at)
approval_requests         (id, tenant_id, type, subject_type, subject_id, requester_id,
                           status, payload, created_at, decided_at, decided_by)
handover_items            (id, approval_id, asset_type, asset_id, from_user_id,
                           to_user_id, transferred_at)
```

### 5.2 字段变更

| 表 | 变更 | 原因 |
|---|---|---|
| `users` | 新增 `status: active / pending_handover / disabled` | 登录冻结与停用 |
| `memberships` | 状态增加 `pending_removal` | 交接期间锁死 |
| `audit_events` | 复用现有 `action / payload` | 记录授权 diff、交接、审批 |

### 5.3 迁移顺序

```text
0005_permissions.sql        → 授权表 + 模板回填
0006_pending_handover.sql   → users.status + pending_removal + 审批表
010_permission_grants.sql   → 授权表 RLS / SECURITY DEFINER 函数
011_handover_approval.sql   → 审批表 RLS / 状态机函数
```

> `pending_removal` 如果用 PostgreSQL enum，建议单独迁移、不要与"使用该值"同事务；否则改用 `text + check`。

### 5.4 授权数据原则

- `scope_type` 必须与 `permission_key` 的动作类型匹配：写动作禁止 `DEPT_TREE`。
- `scope_id` 为空仅允许 `ALL / SELF`；`DEPT / DEPT_TREE` 必须带部门 id。
- `effect = deny` 需要保留，用于收回模板授权。
- `expires_at` 支持临时授权。
- 所有写操作走 `SECURITY DEFINER` 函数，`jxf_app` 不直接 UPDATE/DELETE 授权表。

### 5.5 扩展接口（财务 / 教学 / CRM 预留）

- `permission_key` 使用 `text`，不建模块专属表；新增模块只加目录节点与授权行。
- 模块注册表放在 `catalog.ts`，不落库；`enabled` 控制是否参与解析与展示。
- `approval_requests.type` 是文本，后续可增加财务导出、投放发布等类型。
- `handover_items.asset_type` 是文本，后续注册新适配器即可，不改表。
- 新增模块的接入清单：注册模块 → 增加节点 → 增加守卫 → 注册资产适配器（如有）→ 增加面板分组。**不需要改判定主流程。**

---

## 六、UI 页面清单

| 页面 | 路由 | 权限 | 内容 |
|---|---|---|---|
| 我的权限 | `/me/permissions` | 登录即可 | 有效节点、Scope、来源、拒绝原因；调试信息折叠 |
| 权限管理 | `/settings/permissions` | 仅 L1 | 角色模板 / 成员授权 / 变更记录 |
| 审批中心 | `/me/approvals` | L1 / 相关审批人 | 待交接、资产明细、通过/驳回/撤回 |
| 组织架构 | `/org/positions` | `org:view` | 按钮按 `can()` 显隐/禁用；交接向导 |
| 个人资料 | `/me/profile` | `profile:view` | 编辑区按 `can()` 控制 |
| 审计日志 | `/me/audit` | `audit:read` | 新增授权变更、交接、审批事件文案 |
| 外壳 | 全局 | — | 部门切换器、待审批铃铛 |

### 6.1 交互规范

- **模块过滤**：权限管理面板只渲染 `PermissionModule.enabled=true` 的模块；财务/教学/投放本轮不显示入口。
- **隐藏**：整个模块无权限时隐藏导航与入口。
- **禁用**：有查看无操作时禁用按钮，hover 显示缺失节点与 Scope。
- **二次确认**：高危动作（移出、交接、授权、ship）必须二次确认。
- **原因可读**：拒绝文案统一由 `authorize()` 返回的 `reason` 生成，不在组件里手写。

---

## 七、测试与验收矩阵

| 层 | 用例 | 期望 |
|---|---|---|
| 单元 | L3 勾 `member:manage` | 保存拒绝或运行时拒绝 |
| 单元 | L2 给下属勾 `platform:settings` | 拒绝（超出授予上限） |
| 单元 | `deny` 覆盖模板 allow | 拒绝 |
| 单元 | 未知 key | 拒绝并记日志 |
| 单元 | 保护区节点 | 仅 L1，且不出现在目录 UI |
| 单元 | 未启用模块（财务/教学/投放） | 不参与解析、不出现在面板、授权保存被拒绝 |
| 集成 | A 部门 L3 + B 部门 L2，切到 A | 只有 L3 能力，写不到 B |
| 集成 | L2 改子部门成员资料 | 只读，写拒绝 |
| 集成 | Pending Handover 登录 | 拒绝，提示交接中 |
| 集成 | L1 审批交接 | 资产转移 + 成员 removed + 用户 disabled |
| 集成 | 驳回/撤回 | 状态完全回滚 |
| 集成 | 最后一位 L1 移出 | 数据库与应用层都拒绝 |
| 静态 | 守卫覆盖脚本 | 0 未覆盖（白名单除外） |
| 静态 | 全仓 grep 旧判断 | 无 `level === "L1"` 散落判定 |

### 7.1 不变量测试（必须自动化）

1. `effective ⊆ ceiling(level)`
2. 授予者只能授予自己拥有的节点
3. 写动作 Scope 不含 `DEPT_TREE`
4. 多任用不合并
5. `deny` 优先
6. 最后一个 L1 不可移除
7. 保护区不可授权

---

## 八、风险与回滚

| 风险 | 应对 |
|---|---|
| P3 作用域改造破坏现有页面 | 先影子模式；灰度按页面切换；旧 `departmentIds` 只读兼容一个版本 |
| 迁移不可逆 | 每个迁移附回滚 SQL；enum 变更单独评审 |
| 回填错误导致权限过大 | 回填后跑"L1/L2/L3 行为对比脚本"，人工抽检 |
| 面板误操作 | 保存前 diff + 二次确认；高危节点需 L1 再确认 |
| 审批流死锁 | 唯一 L1 自动通过 + 留痕；或强制先转让 L1 |
| 缓存导致权限不生效 | `permission_revisions.version` + `revalidateTag` + 测试用例 |
| 资产表未建 | 适配器返回 0，但接口与状态机先就位 |
| 权限目录膨胀 | 每模块节点上限；新增需评审；废弃保留 `replaced_by` |
| 后续接入财务/教学/投放时返工 | 本轮已预留命名空间、模块注册表、通用判定与适配器接口；接入只加目录与守卫，不改主流程 |

### 8.1 回滚策略

- 代码回滚：每个阶段独立 commit，可单独 revert。
- 数据回滚：迁移附 `down` SQL；授权表保留历史版本，不物理删除。
- 功能回滚：P4 影子模式可一键关闭强制；P5 Provider 可降级为旧布尔判断一个版本。

---

## 九、工程约束

1. 业务写入必须走 `withUserContext`，不允许直接 `getPool().query`。
2. 新增表必须启用 RLS；权限表写操作走 `SECURITY DEFINER` 函数，不放开整表 UPDATE/DELETE。
3. 所有授权变更与审批动作必须与 `auditInTx` 同事务。
4. 新增 PermissionNode 必须同时更新目录、测试、文档；不允许只加代码。
5. 前端只消费服务端快照；不允许在组件里重新推导等级。
6. 保护区逻辑永远硬编码，不进入任何配置面板。
7. 任何写入口必须有 `requirePermission`；守卫覆盖脚本作为 CI 门禁。
8. 权限变更后必须让缓存失效，禁止"要刷新才生效"。
9. 未启用模块不得创建 PermissionNode 或授权行；接入时必须走"注册模块 → 加节点 → 加守卫"的固定流程。

---

## 十、第一阶段启动包

建议第一批只做 P0 + P1，交付（仅核心模块）：

1. `docs/architecture/permission-model.md`（语义冻结 + 范围裁剪说明）
2. `src/lib/permissions/catalog.ts` + `scope.ts`（目录、模块注册表与 Scope）
3. `src/types/permission.ts`（类型）
4. `db/migrations/0005_permissions.sql` + `db/schema/permission-grants.ts`
5. 回填脚本与"现有行为 → 新模板"对照表（财务/教学/投放不生成授权）
6. 单元测试骨架（先只覆盖 ceiling 与 scope 匹配、未启用模块拒绝）

**P0/P1 完成标准**

- 目录能评审；
- 类型能编译；
- 迁移能在空库与现有库上幂等执行；
- 回填后 L1/L2/L3 行为有对照报告；
- 财务/教学/投放模块节点数为 0，扩展接口可用。

以上条件通过后再进入 P2 写 `authorize()`，避免后面反复改签名。
