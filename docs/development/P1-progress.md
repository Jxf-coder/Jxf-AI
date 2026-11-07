# P1 推进账本（Rolling Progress Log）

> 用途：记录 P1 阶段每一次实际推进，作为对话之外的唯一可回溯依据。
> 关联基准：[master-plan.md](../architecture/master-plan.md)、[P1-gate.md](../gates/P1-gate.md)、[P1-auth-rls.md](./P1-auth-rls.md)
> 记录规则：
> 1. 每次推进按日期追加一条，不改写历史；
> 2. 必须写清「需求 → 代码/迁移 → 验收证据 → 与原方案的偏差」；
> 3. 未提交的改动标注「未提交」，避免把工作区当成已完成版本；
> 4. 闸门验收步骤如已过时，先记为偏差，不擅自改 Gate。

---

## 0. 当前状态（2026-11-04）

| 项目 | 状态 |
|---|---|
| 基线 | P1 Gate 已产出，自动化证据为 `test:rls passed=18`、`typecheck`、`build` |
| 本轮推进 | 权限系统 P0–P7：目录、授权表、鉴权核心、单部门上下文、写入口守卫、前端快照、权限管理面板、离职交接与审批中心；另完成一轮全局 UI 控件归一化 |
| 版本记录 | **本轮改动全部未提交**（含权限底座与之前 P1 扩展） |
| 数据库 | 迁移 7 条（`0000`–`0006`）；策略 14 个（`001`–`014`），已在本地 Docker 环境应用 |
| 与原方案关系 | master-plan 的阶段定义未变；权限系统按 `docs/architecture/permission-model.md` 推进，P8 尚未开始 |

---

## 1. 本轮变更记录

### 2026-10-30 · 组织架构交互增强

| 需求 | 实现 | 证据 |
|---|---|---|
| 添加成员的业务岗位改为自由输入 | 移除 `datalist` 与预置岗位建议，保留自由文本 | `org/positions/page.tsx` |
| 部门支持拖拽排序（如「股东」拖到「销售部」前） | `departments.sort_order`；`reorderDepartments` 只允许同父级重排；新建部门自动排到同级末尾 | 迁移 `0003`、`OrgTree.tsx`、`actions.ts` |
| 成员可拖到其他部门，且必须二次确认 | `moveMember` + Apple 风格确认弹窗（移动到/取消） | `OrgTree.tsx`、策略 `005` |
| 跨级拖动需防误触 | 非同级拖动提示「只能在同一上级部门下拖动排序」 | `OrgTree.tsx` |
| 删除部门增加二次确认 | 红色破坏性按钮 + Ghost 取消 | `OrgTree.tsx` |
| 非空部门不允许删除，且不能反复弹窗 | 有成员/子部门时直接提示「请先清空」，不打开确认框；后端仍兜底校验 | `OrgTree.tsx`、`actions.ts` |

### 2026-10-30 · 成员移出改为软删除

| 需求 | 实现 | 证据 |
|---|---|---|
| 移出必须二次确认，文案含「无法再登录 / 审计与资产保留」 | 移出确认弹窗（取消 / 确认移出） | `OrgTree.tsx` |
| 禁止物理删除 | `app.remove_membership` 仅置 `memberships.status='removed'`，无 `DELETE` | 策略 `001`、`actions.ts` |
| 停用后无法登录 | 登录时校验有效任用，无任用拒绝登录 | `src/auth.ts` |
| 查看已停用成员并恢复 | 组织架构下方折叠区「已停用成员 (N 人)」；`restoreMember` → `status='active'` | 策略 `006`、`OrgTree.tsx` |
| 验证 | 事务内实测：`removed → active`，随后 `ROLLBACK`（无测试脏数据） | psql 手工验证 |

### 2026-10-30 · 移出前工作/资产预检

| 需求 | 实现 | 证据 |
|---|---|---|
| 有运行中工作或资产时，必须先改派才能移出 | `app.membership_blockers` 返回 `{open_work, assets}`；前端点击移出先预检，后端移出前再次校验 | 策略 `007`、`actions.ts`、`OrgTree.tsx` |
| 当前无工作/资产模块 | 用 `to_regclass` + 列存在性降级：M2 `assets` / M3 `runs` 建表后自动生效 | 实测返回 `{"assets":0,"open_work":0}` |

### 2026-10-30 · 提示条细节

- 提示条右上角「关闭」文字改为 `×` 图标，固定最右侧，hover 有浅色背景。

### 2026-10-30 · 导航文案

- 左侧导航「组织与岗位」更名为「组织架构」（`src/components/shell/Shell.tsx`）。

### 2026-10-30 · 审计与权限拆分

| 需求 | 实现 | 证据 |
|---|---|---|
| 审计从权限页独立出来 | 新页面 `/me/audit`；`/me/permissions` 只保留权限上下文与可见部门 | `me/audit/page.tsx`、`me/permissions/page.tsx` |
| 审计覆盖组织/成员/资料变更 | 汇总部门的增删改与排序、成员新增/移出/恢复/换部门、岗位/权限变更、手机号/头像/邮箱变更、登录 | 审计动作映射 `describeAudit` |
| L1 看全部、L2 看本人+本部门、L3 只看本人 | `audit_events.department_id` + 新读取策略 `009_audit_scope.sql` | 事务内实测：L2=3、L3=2、L1=5（符合预期） |
| 菜单入口 | 个人菜单「审计」→「审计日志」，指向 `/me/audit` | `ProfileMenu.tsx` |
| 移除重复入口 | 删除组织架构页底部旧「最近审计（仅 L1 可见）」卡片；Command Palette 的审计入口同步指向 `/me/audit`，并同步「组织架构」命名 | 两处查询与文案已统一为单一审计页 |

### 2026-10-30 · 个人资料 / Profile 模块

| 需求 | 实现 | 证据 |
|---|---|---|
| macOS 设置风格（Inset Grouped / 发丝边框 / backdrop-blur） | `.settings-*` 样式组；`/me/profile` 页面 | `globals.css`、`me/profile/page.tsx` |
| 头像上传/更换 | 前端读取为 data URL（≤300KB），存 `users.image` | `ProfileClient.tsx`、`actions.ts` |
| 姓名/手机/多邮箱：本人可改、上级可改下级 | `computeProfilePermissions`：L1 全部；L2 仅下级 L3；本人可改 | `lib/profile/access.ts` |
| 手机号修改验证 | 本人修改需验证当前密码；登录支持邮箱或手机号 | `actions.ts`、`src/auth.ts`、`/login` |
| 岗位：L1 全部；L2 仅下级 L3；L3 只读 | 应用层预判 + 数据库函数双校验 | 策略 `008` |
| 部门/等级：仅 L1，其他角色显示 🔒 | 服务端动作只向数据库传 L1 可改字段；UI 只读锁标 | `ProfileClient.tsx` |
| 多邮箱：添加、设默认主邮箱、解绑 | `user_email_identities` 1:N；首个邮箱自动主邮箱；主邮箱同步登录邮箱 | `actions.ts`、策略 `008` 数据修复 |
| 导出标准接口 | `UserProfile` / `UserEmailIdentity` / `UserMembershipSummary` / `ProfilePermissions` | `src/types/profile.ts` |
| 入口 | 个人菜单「个人资料」；组织架构成员姓名可跳转 | `ProfileMenu.tsx`、`OrgTree.tsx` |

**权限矩阵（已实现）**

| 字段 | L1 | L2 | L3 |
|---|---|---|---|
| 头像 / 姓名 / 手机 / 多邮箱 | 所有人 | 下级 L3 | 仅本人 |
| 业务岗位 title | 所有人 | 下级 L3（不含自己/同级 L2） | 只读 |
| 所属部门 / 权限等级 | 所有人 | 只读 | 只读 |
| 最后一位 L1 降级 | 拒绝（`cannot demote the last L1`） | — | — |

### 2026-11-02 · 权限系统 P0 / P1（双轨权限底座）

| 需求 | 实现 | 证据 |
|---|---|---|
| 冻结权限语义 | 新增 `docs/architecture/permission-model.md`：三轴模型、Scope、6 条语义、9 条不变量、保护区与扩展流程 | 文档评审稿 |
| 权限目录 | `src/lib/permissions/catalog.ts`：9 个启用模块 + 3 个预留模块（财务/教学/CRM，`enabled=false`），25 个 PermissionNode | `npm run test:permissions` |
| 作用域 | `src/lib/permissions/scope.ts`：`ALL / DEPT_TREE / DEPT / SELF`、覆盖判定、资源归属匹配 | 单测 155 项 |
| 类型 | `src/types/permission.ts`：`PermissionScope`、`PermissionGrant`、`PermissionSnapshot`、`PermissionCheckResult` | `tsc --noEmit` |
| 数据表 | `0005_permissions_and_handover.sql`：`role_templates / role_template_grants / user_permission_grants / permission_revisions / approval_requests / handover_items`；`users.status`；`membership_status.pending_removal` | Docker PG16 已应用 |
| 系统模板 | `010_permission_grants.sql`：L1 25 条、L2 12 条、L3 7 条；清空财务/教学/CRM 残留 | 实测 `l1:25, l2:12, l3:7` |
| 审批表 RLS | `011_handover_approval.sql`：L1 读写审批单与交接明细；申请人可读 | 策略已应用 |
| 自检脚本 | `scripts/test-permissions.mjs`：目录不变量、等级上限、Scope、模板、保护区、未启用模块 | `passed=155 failed=0` |

**本轮范围裁剪**：财务与经营、教学与教务、市场投放 / CRM 不创建权限节点，只保留模块位与命名空间；`catalog.ts` 中 `enabled=false`，配置面板不渲染。

偏差：
- 计划中的 `0005` / `0006` 两条迁移由 `drizzle-kit generate` 合并为 `0005_permissions_and_handover.sql`，未拆文件。
- `user_permission_grants` 与 `permission_revisions` 的写入已对 `jxf_app` 撤销，等待 P2 的 SECURITY DEFINER 函数。
- P1 只落数据与目录，尚未接任何页面守卫；`usePermission` 在 P5。

待办：
- [ ] P2：`resolve / authorize / grant / guard` + 不变量单测
- [ ] P3：单部门上下文与 RLS 作用域修复
- [ ] 后续接入财务/教学/CRM 时按 `permission-model.md` §10 流程扩展

### 2026-11-02 · 权限系统 P2（服务端鉴权核心）

| 需求 | 实现 | 证据 |
|---|---|---|
| 等级上限 | `src/lib/permissions/ceiling.ts`：`ceilingFor / ceilingSet / isWithinCeiling` | 单测 |
| 有效权限解析 | `src/lib/permissions/resolve.ts`：模板 + 用户授权 + deny + 过期/越级/未知节点过滤；L1 全量 | `test:permission-core` |
| 数据库加载 | `loadGrantRules(client, {tenantId,userId,level})`：模板、用户授权、版本号一次读取 | `tsc`；P3 接入上下文 |
| 动作判定 | `src/lib/permissions/authorize.ts`：节点、等级、deny、Scope、资源归属、保护区 | 单测 |
| 授权上限 | `src/lib/permissions/grant.ts`：v1 仅 L1；目标等级上限、系统保留节点、Scope 合法性、过期时间 | 单测 |
| 服务端守卫 | `src/lib/permissions/guard.ts`：`requirePermission / requireAnyPermission / requireProtectedCapability / PermissionDeniedError` | 单测 |
| 资源上下文 | `ResolvedPermissions` 增加 `userId`；`PermissionResource` 强制从数据库资源行取值 | `src/types/permission.ts` |
| 自检 | `scripts/test-permission-core.mjs`：33 项 | `passed=33 failed=0` |

偏差：
- `resolve.ts` 的数据库加载函数尚未接入 `withUserContext`，计划在 P4 守卫接入时统一调用。
- `guard` 对非 `ALL` 节点强制要求资源上下文，页面预检请使用 `authorize()`，不要用 `guard`。

待办：
- [ ] P3：单部门上下文与 RLS 作用域修复
- [ ] P4：所有 Server Action / Route Handler 接入 `requirePermission`

### 2026-11-02 · 权限系统 P3（单部门上下文与作用域修复）

| 需求 | 实现 | 证据 |
|---|---|---|
| 单部门上下文 | `resolveUserContext` 只解析一条 `activeMembership`；新增 `activeDepartmentId / subtreeDepartmentIds / activeMemberships` | `test:context` |
| 多任用切换 | `jxf_active_department` httpOnly Cookie + `listActiveMemberships` 服务端校验；Shell 增加部门切换器 | `DepartmentSwitcher.tsx`、`(app)/actions.ts` |
| RLS 作用域根 | `SET LOCAL app.department_ids`：L1 全租户、L2/L3 仅当前部门；新增 `app.tenant_department_ids` | `012_active_membership_context.sql` |
| 子树计算 | `app.department_subtree_ids` SECURITY DEFINER；策略不递归 | `test:context` |
| 登录冻结 | `users.status` 非 active 时 `authorize` 拒绝；`requireSession` 每请求校验并跳登录页提示 | `auth.ts`、`session.ts`、`login/page.tsx` |
| 登录页提示 | `pending_handover` / `disabled` 显示明确原因 | `LoginForm.tsx` |
| L2 写边界 | `app.update_membership_profile` 的 L2 改 title 增加 `app.can_write(目标部门)` | `008` |
| 自检 | `scripts/test-active-context.mjs`：多任用、读/写作用域、审计、冻结登录 | `passed=15 failed=0` |
| 部署 | `migrate` 6 条迁移 / 12 个策略；`web` healthy；对外入口为 Caddy `:80`，web 容器 `3000` 不映射宿主机 | `docker compose logs migrate` |

偏差：
- `department_packs` 的写策略仍只校验 `can_write`，尚未收紧为 L1；列入 P4。
- 多任用切换器只在侧栏/抽屉出现，移动端布局需在 P5 统一验收。
- `resolveUserContext` 每请求多一次任用/子树/版本查询；后续可加请求级缓存。

待办：
- [ ] P4：所有写入口接入 `requirePermission`，并收紧 `department_packs` 等历史宽松点
- [ ] P5：`PermissionProvider` / `usePermission` 与 UI 三态

### 2026-11-02 · 权限系统 P4（写入口守卫接入）

| 需求 | 实现 | 证据 |
|---|---|---|
| 组织架构写入口 | `createDepartment / updateDepartment / deleteDepartment / reorderDepartments` 在事务内读取部门行后接 `org:manage` | `org/positions/actions.ts` |
| 成员写入口 | `addMember / removeMember / restoreMember / moveMember` 接 `member:manage`；新增 L1/L2 额外校验 `member:level`；`checkMemberBlockers` 接 `member:view` | 同上 |
| 资料写入口 | `updateCoreProfile`、邮箱增删改、`updateMembershipAssignment` 统一走 `requireProfileEditPermission`：本人 `profile:edit_self`（SELF），他人 `member:profile`（DEPT） | `me/profile/actions.ts` |
| 组织/等级变更 | 调部门接 `member:manage`（源 + 目标部门各一次），调等级接 `member:level` | 同上 |
| L2 写边界收紧 | 资料编辑按 `DEPT` 判定，L2 不再能改子部门成员资料（与数据库 `can_write` 一致） | `test:permission-core` |
| `department_packs` 收紧 | `UPDATE / DELETE` 增加 `app.current_access_level() = 'L1'` | `db/policies/002_rls_policies.sql` |
| 守卫覆盖脚本 | 扫描全部 `actions.ts` / `route.ts`；未覆盖必须进白名单并写原因 | `scripts/verify-permission-guards.mjs`、`npm run verify:guards` |
| 影子模式 | `JXF_PERMISSION_SHADOW=1` 时只记差异不阻断 | `src/lib/permissions/server.ts` |
| 知识卡确认/删除 | 表尚未建立，本轮无可接入入口，标 `deferred` | — |
| 财务/教学代理 | 仓库内暂无对应 Route Handler，标 `deferred` | — |

偏差：
- 页面只读入口（`/org/positions`、`/me/audit`、`/me/profile`）尚未接读守卫，按计划留给 P5；当前仍由 RLS 兜底。
- `requiresApproval` 节点（如 `member:manage`）当前只靠等级上限拦到 L1，尚未生成 `approval_requests`；审批流在 P7。
- `requireContextPermission` 每次调用重新加载模板与用户授权；`addMember` / `moveMember` 最多调用两次，后续加请求级缓存。
- L3 审计页仍按 RLS 显示本人记录，但目录未给 L3 授予 `audit:read`；语义差异留到 P5/P6 评审。
- 本地数据库的新策略是直接以 `jxf_owner` 应用验证的；`migrate` 镜像内打包了 `db/policies`，需要重新 `docker compose build migrate` 才会随镜像携带（本轮镜像 build 未完成）。
- 运行中的 `web` 仍是 P3 镜像；P4 守卫需重建 `web` 镜像后才能在浏览器验收。

待办：
- [ ] P5：`PermissionProvider` / `usePermission` 与页面三态
- [ ] P6：权限管理面板（角色模板 / 成员授权 / 变更记录）
- [ ] 为 `requireContextPermission` 增加请求级缓存
- [ ] 评审 L3 审计读取：新增节点或显式在策略中允许

### 2026-11-02 · 权限系统 P5（前端快照与页面接入）

| 需求 | 实现 | 证据 |
|---|---|---|
| 服务端快照 | `(app)/layout.tsx` 在 `withUserContext` 内解析权限并注入 `<PermissionProvider>`；只下发允许的 key + 最宽 Scope | `layout.tsx`、`snapshot.ts` |
| 客户端 Hook | `usePermission()` 提供 `can / check / level / snapshot` | `components/permissions/usePermission.ts` |
| 声明式组件 | `<Can permission scope fallback>` | `components/permissions/Can.tsx` |
| 导航与搜索 | 侧栏、移动抽屉、⌘K、个人菜单按 `org:view` / `audit:read` / `profile:view_self` 隐藏入口 | `Shell.tsx`、`CommandPalette.tsx`、`ProfileMenu.tsx` |
| 组织架构 | `OrgTree` 内部派生 `org:manage` / `member:manage` / `member:view@DEPT_TREE`，不再接收粗粒度布尔；只读时显示原因 | `OrgTree.tsx` |
| 个人资料 | 新增 `computeProfilePermissionsFromActor`：原有上下级规则叠加 `authorize()`，L2 越过子部门时不显示编辑态 | `profile/access.ts`、`me/profile/page.tsx` |
| 只读页守卫 | `/org/positions` → `org:view`；`/me/audit` → `audit:read`；`/me/profile` → `profile:view_self` / `member:view` | 三个页面 |
| UI 三态 | 无权限隐藏入口；只读显示缺失原因；编辑按钮按权限渲染或锁定 | 同上 |
| 自检 | `scripts/test-permission-snapshot.mjs`：快照序列化、Scope 覆盖、deny、L1 全量 | `npm run test:snapshot` |
| 缓存 | 页面均为动态渲染；授权变更面板在 P6 引入后统一加 `revalidateTag` / `router.refresh()` | — |

偏差：
- 客户端 Scope 只做「节点 + 宽度」近似，不判断资源归属；最终仍以服务端守卫与 RLS 为准。
- L3 不再能打开 `/me/audit`：目录未授予 `audit:read`，按冻结模型收紧；若业务需要保留，P6 再评审是否加节点。
- `ProfileClient` 仍接收服务端派生视图，不在组件内重新推导等级；符合「UI 不持有业务规则」。
- 运行中的 `web` 仍是 P3/P4 之前的镜像，P5 页面需重建镜像后做浏览器验收。

待办：
- [ ] P6：权限管理面板（角色模板 / 成员授权 / 变更记录），保存后失效缓存
- [ ] 为页面与守卫共用的权限解析增加请求级缓存
- [ ] 重建 `web` / `migrate` 镜像并做移动端浏览器验收

### 2026-11-02 · 权限系统 P6（Apple 风权限管理面板）

| 需求 | 实现 | 证据 |
|---|---|---|
| 权限管理页 | `/settings/permissions`，仅 L1；三段式 Segmented Control | `settings/permissions/page.tsx` |
| Apple 风 UI | Inset Grouped、发丝线、毛玻璃、系统开关、风险徽章、Scope 下拉、粘性保存条 | `PermissionAdminClient.tsx`、`globals.css` |
| 角色模板 Tab | L1/L2/L3 切换；按模块折叠；开关 + Scope；L1 模板只读 | `TemplatePanel.tsx` |
| 成员授权 Tab | 成员搜索列表、三态（继承/允许/拒绝）、模板默认提示、个人覆盖计数、恢复默认 | `MemberPanel.tsx` |
| 变更记录 Tab | 最近 50 条权限变更，显示操作者、对象、时间 | `AuditPanel.tsx` |
| 授权写入函数 | 成员授权整体替换 / 清空 / 模板替换；每次同步递增 `permission_revisions` | `db/policies/013_permission_admin.sql` |
| 服务端校验 | `requireProtectedCapability(protected:permission_grant)` + 逐条 `canGrant` + 等级上限 + 系统保留节点 | `settings/permissions/actions.ts` |
| 审计 | 模板/成员授权变更与业务写入同事务；审计页补充文案 | `actions.ts`、`me/audit/page.tsx` |
| 缓存失效 | 保存后 `revalidatePath('/settings/permissions' / '/me/permissions' / '/')` | `actions.ts` |
| 入口 | 侧栏、⌘K、个人菜单仅 L1 可见 | `Shell.tsx`、`CommandPalette.tsx`、`ProfileMenu.tsx` |
| 我的权限 | `/me/permissions` 增加「我的有效权限」分组视图 | `me/permissions/page.tsx` |
| 自检 | 授权函数、版本号、L1 限制、模板回滚 | `npm run test:permission-admin-db` |
| 渲染冒烟 | 临时 L1 登录 → 页面 200 → 角色模板/成员授权/有效权限/组织架构均渲染 | 11 项 PASS |

偏差：
- 模板 Tab 只暴露 `allow`（开关 + Scope）；`deny` 仅在成员授权中提供，避免模板级 deny 造成不可见覆盖。
- L1 模板只读：L1 在解析时短路为全量，修改模板没有实际效果。
- 本地数据库直接应用了 `013` 策略；`migrate` 镜像仍需重建才会携带。
- 未做截图级浏览器验收；渲染冒烟验证了登录、200 响应与关键 UI 结构，CSS 已确认打包进 `.next/static/css`。
- `member:manage` 的 `requiresApproval` 仍未生成审批单，留给 P7。

待办：
- [ ] P7：Pending Handover 状态机、审批中心、资产交接适配器
- [ ] 重建 `web` / `migrate` 镜像，补充移动端截图验收
- [ ] 模板级 deny 是否开放，待 P7 与审批流一起评审

### 2026-11-04 · 全局 UI 控件归一化（去碎片化）

| 需求 | 实现 | 证据 |
|---|---|---|
| 全系统唯一开关 | 新增 `src/components/ui/switch.tsx`；删除 `PermissionSwitch`；`perm-switch*` 样式收敛为 `ui-switch*` | `TemplatePanel.tsx`、`globals.css` |
| 折叠箭头唯一 | 新增 `ui/icons.tsx`（lucide-react）与 `ui/collapsible.tsx`；权限分组、已停用成员、个人菜单 chevron 统一走 `ChevronIcon` | `TemplatePanel.tsx`、`MemberPanel.tsx`、`OrgTree.tsx`、`ProfileMenu.tsx` |
| 下拉 / 提示条唯一 | 新增 `ui/select.tsx`、`ui/notice-bar.tsx`；3 处 `×` 关闭符替换为 `CloseIcon` | `parts.tsx`、`ProfileClient.tsx`、`PermissionAdminClient.tsx` |
| 图标唯一出口 | 侧栏、个人菜单、⌘K 共 11 处内联 `<svg>` 改为 lucide 封装 | `Shell.tsx`、`ProfileMenu.tsx`、`CommandPalette.tsx` |
| 开关位置 | 行控件改为 `[固定宽作用域插槽][开关]`，开关永远贴最右，开/关位置稳定 | `TemplatePanel.tsx`、`globals.css` |

偏差：
- 成员授权行是「继承 / 允许 / 拒绝」三态，无法压缩成二元开关，保留下拉但固定在最右。
- 组织表单里的原生 `<select>` 需要 `name` 随表单提交，未套用 `ui/select`。

### 2026-11-04 · 权限系统 P7（离职交接与审批中心）

| 需求 | 实现 | 证据 |
|---|---|---|
| 移出预检明细 | `checkMemberBlockers` 返回按资产类型分组的明细（适配器汇总） | `org/positions/actions.ts` |
| 交接向导 | 有资产时打开逐项选择接收人的弹窗，接收人校验有效任用且不能是本人 | `OrgTree.tsx` |
| 交接状态机 | `app.create_membership_removal_request / approve / reject / cancel / pending_approval_count`；同一任用仅一条 pending（部分唯一索引） | `db/policies/014_pending_handover.sql` |
| 任用状态约束 | `memberships_removed_shape` 放开 `pending_removal`（removed_at 为空） | 迁移 `0006` |
| 会话失效 | 创建审批后 `memberships.pending_removal` + `users.pending_handover`；`requireSession` 每请求校验 | `014`、`session.ts` |
| 多任用保护 | 仍有其他 active 任用时账号不冻结，审批通过也不置 disabled | `014` |
| 资产适配器 | `AssetAdapter { listBlocking, transfer }`；注册 `agent` / `knowledge`，表未建返回 0 | `src/lib/handover/adapters.ts`、`registry.ts` |
| 审批中心 | `/me/approvals`：待审批卡片（成员 / 部门 / 申请人 / 资产明细）+ 通过 / 驳回 / 撤回 + 已处理列表 | `me/approvals/page.tsx`、`ApprovalsClient.tsx` |
| 审批写入 | 通过前先调用资产适配器转移，再执行数据库状态机；审批与审计同事务 | `me/approvals/actions.ts` |
| 顶栏待办 | 铃铛 + 待审批数量（`app.pending_approval_count`），非 L1 恒为 0 | `Shell.tsx`、`(app)/layout.tsx` |
| 入口 | 侧栏「审批中心」、个人菜单、⌘K；审计文案补「发起离职交接 / 通过 / 驳回 / 撤回」 | 同上、`me/audit/page.tsx` |
| 守卫覆盖 | 审批三个入口共用 `runDecision`，守卫脚本支持本地包装函数的传递判定 | `scripts/verify-permission-guards.mjs` |
| 自检 | 创建 / 幂等 / 非 L1 / 最后一位 L1 / 通过 / 驳回 / 撤回 / 冻结登录 | `npm run test:handover`（passed=23） |

偏差：
- M2/M3 资产表未建，`knowledge` / `agent` 适配器当前返回 0，交接向导在真实数据出现前不会触发；状态机与页面已就位。
- `agent` 适配器在表建好前未实现 transfer，若手工写入该类型明细会在审批时 fail-closed 报错。
- 单部门上下文下，审批人固定为 L1（与 RLS `011` 一致）；多 L1 会签留到后续评审。
- 交接期间同一（用户, 部门）未加唯一约束，靠流程保证不重复添加。

待办：
- [ ] P8：收尾与验收（迁移幂等、权限拒绝日志、文档定稿）
- [ ] M2 `assets` 表落地后补 `agent` 适配器 transfer 与真实交接数据回归
- [ ] 补充移动端截图级浏览器验收

### 2026-11-04 · 权限系统 P8（收尾与验收）

| 需求 | 实现 | 证据 |
|---|---|---|
| 迁移幂等回归 | 空库 `jxf_p8_check` → 首轮 `applied_migrations=7 / policies=14` → 二次执行 | 二次指纹完全一致（`7,16,32,23,b47e…,4cde…`） |
| 修复首轮迁移失败 | 新库同事务内使用刚新增的枚举值触发 `unsafe use of new value`；`0006` 改为 `status::text` 比较 | `0006_pending_removal_shape.sql`、`memberships.ts`、`0006_snapshot.json` |
| 权限拒绝日志 | `permission_denied` 补齐 `user / permission / level / resource(kind,id,department,owner) / reason / shadow / request_id` | `src/lib/permissions/server.ts` |
| 文档定稿 | `permission-model.md` 标记 P0–P7 定稿，补「废弃节点」「重命名 Key」流程与 P8 验收口径 | `docs/architecture/permission-model.md` |
| 部署 | 重建 `migrate` / `web` 镜像并重启；migrate 7 迁移 / 14 策略 | `docker compose logs migrate` |
| 回归 | `test:handover 23`、`test:rls 18`、typecheck、build 全通过 | 本地执行 |

偏差：
- 移动端截图级浏览器验收需要登录态，本轮未在自动化中完成，保留人工验收清单。
- 影子模式「差异归零」以「正常模式无 `permission_denied` 日志」作为观测口径，暂无独立对比脚本。

待办：
- [ ] 人工完成移动端验收（登录、组织架构、权限面板、审批中心 390px 布局）
- [ ] M2 `assets` 落地后补 `agent` 适配器与真实交接数据回归


---

## 2. 数据库变更清单

| 类型 | 文件 | 说明 |
|---|---|---|
| 迁移 | `db/migrations/0003_p1_org_sort_order.sql` | `departments.sort_order`（含 snapshot / journal） |
| 策略 | `db/policies/005_membership_move.sql` | `app.move_membership`：成员换部门（SECURITY DEFINER） |
| 策略 | `db/policies/006_membership_restore.sql` | `app.restore_membership`：恢复已停用任用 |
| 策略 | `db/policies/007_membership_blockers.sql` | `app.membership_blockers`：移出前工作/资产预检（预留 M2/M3） |
| 策略 | `db/policies/008_profile_membership_update.sql` | `app.update_membership_profile`（title/部门/等级 + 最后一位 L1 保护）；历史邮箱补主邮箱 |
| 迁移 | `db/migrations/0004_p1_audit_department.sql` | `audit_events.department_id` + 索引（审计分级可见性） |
| 策略 | `db/policies/009_audit_scope.sql` | 审计读取策略：L1 全部 / L2 本人+本部门子树 / L3 仅本人 |
| 迁移 | `db/migrations/0005_permissions_and_handover.sql` | 权限模板/授权/审计版本、审批与交接表；`users.status`；`membership_status.pending_removal` |
| 策略 | `db/policies/010_permission_grants.sql` | 授权表 RLS + 系统模板回填（L1 25 / L2 12 / L3 7） |
| 策略 | `db/policies/011_handover_approval.sql` | 离职交接审批 RLS（L1 读写，申请人可读） |
| 策略 | `db/policies/012_active_membership_context.sql` | 单部门上下文函数：有效任用、子树、全租户部门、权限版本、登录校验 |
| 策略修订 | `db/policies/002_rls_policies.sql` | P4：`department_packs` 的 `UPDATE / DELETE` 收紧为仅 L1 |
| 策略 | `db/policies/013_permission_admin.sql` | P6：成员/模板授权写入函数 + `permission_revisions` 自增 |
| 迁移 | `db/migrations/0006_pending_removal_shape.sql` | P7：`memberships_removed_shape` 允许 `pending_removal` |
| 策略 | `db/policies/014_pending_handover.sql` | P7：离职交接状态机（创建/通过/驳回/撤回/待审批计数）+ 部分唯一索引 |

`memberships` 的 `UPDATE / DELETE` 仍对 `jxf_app` 撤销，所有写入均通过 SECURITY DEFINER 函数完成。

---

## 3. 验收证据（本轮）

```text
npx tsc --noEmit                     → 通过
docker build migrate/web             → 通过
docker compose up -d migrate web     → migrate_completed (policies=8)、web healthy
psql: departments 列                 → 含 sort_order
psql: pg_proc                        → move_membership / restore_membership / blockers / update_membership_profile
psql: 组织更新（L1）                 → org_update_ok
psql: 最后一位 L1 降级               → demote_blocked=cannot demote the last L1
psql: 软删除 + 恢复                  → removed → active（事务回滚）
psql: 移出预检                       → {"assets":0,"open_work":0}
psql: 审计可见性（L2/L3/L1）         → 3 / 2 / 5（事务回滚）
```

P4 / P5 静态与单测证据：

```text
npx tsc --noEmit                     → 通过
npm run test:permission-core         → passed=40 failed=0
npm run test:snapshot                → passed=17 failed=0
npm run test:permissions             → passed=155 failed=0
npm run verify:guards                → entries=22 covered=17 whitelisted=5 uncovered=0
npm run test:rls                     → passed=18 failed=0
npm run test:context                 → passed=16 failed=0（含 L2 不可写 / L1 可写能力包）
npm run test:permission-admin-db     → passed=14 failed=0
npm run test:handover                → passed=23 failed=0
HTTP 渲染冒烟（临时 L1）             → 11 项 PASS；/settings/permissions 200；CSS 含 .perm-tabs
```

> 说明：P1 阶段验证以数据库函数与构建为主；P4 增加写入口守卫与静态覆盖检查。
> `test:context` 的 `department_packs` 用例已改为「L2 不可写 / L1 可写」，并在本地数据库应用新策略后通过。

---

## 4. 与原方案的关系

- **阶段定义未改**：P1 仍是「组织治理与身份链路」，M2 知识库、M3 运行时尚未开始。
- **P1 交付物已扩张**：个人资料、拖拽、软删除、移出预检都不在原始 P1 清单内，属于在 P1 内提前落地的前置能力。
- **风险**：如果不把扩张项写回计划，后续 M2/M3 会出现「实际代码有、计划里没有」的落差；本账本用于先兜住事实。

---

## 5. 已知偏差与待办

### 偏差

1. [P1-gate.md](../gates/P1-gate.md) 第 8、9 步已过时：移出改为软删除 + 确认弹窗；删除部门非空时不再弹出确认框。
2. `scripts/test-rls.mjs` 未覆盖 `005`–`008` 新增函数（换部门、恢复、预检、资料更新）。
3. 本轮改动尚未提交，无法用 commit 回溯。
4. 头像以 data URL 存 `users.image`，未接对象存储（受 300KB 限制）。
5. 移出预检在 M2 `assets` / M3 `runs` 建表前恒为 0，目前只验证了接口与降级逻辑。

### 待办

- [ ] 回填 P1 Gate 验收步骤与新增能力的验收口径
- [ ] 为 `005`–`008` 增加 RLS / 权限自动化测试
- [ ] 将本轮改动拆分为可回溯的 Git commit
- [ ] M2/M3 建表后，确认 `app.membership_blockers` 的列名与状态口径一致
- [ ] 成员清单重构前，复用 `src/types/profile.ts` 的 `UserProfile` 结构

---

## 6. 后续记录模板

```markdown
### YYYY-MM-DD · 主题

| 需求 | 实现 | 证据 |
|---|---|---|
| ... | ... | ... |

偏差：
- ...

待办：
- [ ] ...
```
