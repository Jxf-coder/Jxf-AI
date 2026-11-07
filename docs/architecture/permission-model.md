# 权限模型（P0 语义冻结 · P0–P7 定稿）

> 项目：Jxf-AI 私有化交付工作台
> 版本：v1.0
> 日期：2026-11-02
> 状态：P0 冻结稿，后续代码以本文件为唯一语义依据
> 关联：[权限系统与UI落地实施计划](./权限系统与UI落地实施计划.md)、[原项目权限体系分析报告](./原项目权限体系分析报告.md)

---

## 1. 范围

### 1.1 本轮纳入

成员管理、组织架构、Skill、产线、知识库、MCP 令牌、审计、平台设置、个人资料。

### 1.2 本轮不纳入

财务与经营、教学与教务、市场投放 / CRM / 广告。

> 不纳入不等于删除代码：现有页面与代理层保持原状，只是不创建权限节点、不接守卫、不出现在配置面板。
> 保留 `finance:* / teaching:* / crm:* / ads:*` 命名空间，后续按扩展流程接入。

---

## 2. 三轴模型

| 轴 | 回答的问题 | 载体 |
|---|---|---|
| 等级 | 最多能拿到多高的权限 | `L1 / L2 / L3` |
| 权限点 | 能执行什么动作 | `PermissionNode` |
| 作用域 | 动作能落在哪些数据上 | `ALL / DEPT_TREE / DEPT / SELF` |

判定公式：

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

---

## 3. Scope 语义

| Scope | 含义 | 允许的动作 |
|---|---|---|
| `ALL` | 全租户 | 全局型动作（Skill、平台设置）与 L1 |
| `DEPT_TREE` | 本部门 + 全部直属子部门 | 只允许读类动作 |
| `DEPT` | 严格本部门 | 写 / 管理类动作 |
| `SELF` | 本人或本人创建的资源 | 个人资料、本人数据 |

规则：

1. 写类动作禁止 `DEPT_TREE`。
2. `DEPT / DEPT_TREE` 必须带部门 id；`ALL / SELF` 的 `scope_id` 必须为空。
3. Scope 是授权行的属性，不是节点的全局属性；同一节点可对不同成员授予不同 Scope。
4. Scope 判定必须基于数据库读出的资源行，不能使用客户端传入的 `departmentId`。

### 3.1 当前任用上下文

- 每个请求只解析一条 `activeMembership`，不再把用户全部部门合并。
- 多任用用户通过 `jxf_active_department` Cookie 选择当前部门；服务端校验该部门必须在自己的有效任用内。
- L1 的数据范围是全租户；L2 / L3 的数据范围是当前部门（读子树、写本部门）。
- `SET LOCAL app.department_ids`：L1 写全租户部门；L2 / L3 只写当前部门。
- 子树由 `app.department_subtree_ids()` 计算，不参与 RLS 的祖先数组，避免作用域膨胀。
- 多任用用户的等级按当前任用加载，不再取全局最高等级。

---

## 4. 权限节点目录（25 个）

> 代码位置：`src/lib/permissions/catalog.ts`

### 4.1 成员管理

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `member:view` | 查看成员 | read | low | 开 | 是 | ALL / DEPT_TREE / DEPT / SELF |
| `member:profile` | 编辑成员资料 | write | medium | 关 | 是 | DEPT / SELF |
| `member:manage` | 管理成员 | manage | high | 关 | 是 | DEPT |
| `member:level` | 调整权限等级 | manage | critical | 关 | 否 | DEPT |
| `member:ssh` | 管理 SSH 访问 | manage | high | 关 | 是 | DEPT / SELF |

### 4.2 组织架构

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `org:view` | 查看组织架构 | read | low | 开 | 是 | ALL / DEPT_TREE / DEPT |
| `org:manage` | 管理组织架构 | manage | high | 关 | 是 | DEPT |
| `org:grant` | 管理共享授权 | manage | high | 关 | 是 | DEPT |

### 4.3 Skill

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `skill:use` | 使用 Skill | read | low | 开 | 是 | ALL |
| `skill:edit` | 编辑 Skill | write | medium | 关 | 是 | ALL |
| `skill:publish` | 发布 Skill | publish | critical | 关 | 是 | ALL |
| `skill:create` | 新建 Skill | write | high | 关 | 是 | ALL |

### 4.4 产线

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `pipeline:use` | 运行产线 | read | low | 开 | 是 | ALL |
| `pipeline:manage` | 管理产线 | manage | high | 关 | 是 | ALL |

### 4.5 知识库

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `knowledge:read` | 查看知识库 | read | low | 开 | 是 | ALL / DEPT_TREE / DEPT / SELF |
| `knowledge:write` | 写入知识库 | write | medium | 关 | 是 | DEPT / SELF |
| `knowledge:confirm` | 确认知识卡 | manage | medium | 关 | 是 | DEPT |
| `knowledge:export` | 导出知识交接包 | write | high | 关 | 是 | DEPT |

### 4.6 令牌 / 审计 / 平台 / 个人

| Key | 中文名 | 动作 | 风险 | 默认 | 可授予 | 允许 Scope |
|---|---|---|---|---|---|---|
| `token:issue` | 签发 MCP 令牌 | manage | critical | 关 | 否 | ALL |
| `token:revoke` | 停用 MCP 令牌 | manage | high | 关 | 是 | ALL |
| `audit:read` | 查看审计日志 | read | medium | 关 | 是 | ALL / DEPT_TREE / DEPT |
| `platform:settings` | 管理系统设置 | manage | critical | 关 | 否 | ALL |
| `platform:tenant` | 管理租户与行业 | manage | critical | 关 | 否 | ALL |
| `profile:view_self` | 查看本人资料 | read | low | 开 | 是 | SELF |
| `profile:edit_self` | 编辑本人资料 | write | low | 开 | 是 | SELF |

---

## 5. 等级上限

| 等级 | 定位 | 上限节点 |
|---|---|---|
| L1 | 老板 / Root | 全部 25 个非保护区节点 |
| L2 | 部门管理者 | `member:view`、`member:profile`、`org:view`、`skill:use`、`skill:edit`、`pipeline:use`、`knowledge:read/write/confirm`、`audit:read`、`profile:view_self/edit_self` |
| L3 | 普通成员 | `member:view`、`org:view`、`skill:use`、`pipeline:use`、`knowledge:read`、`profile:view_self/edit_self` |

规则：

1. `effective ⊆ ceiling`，任何勾选都不能突破上限。
2. L1 默认全量，但保护区不参与勾选。
3. L2 的读用 `DEPT_TREE`，写用 `DEPT`。
4. L3 默认 `SELF`，只保留基础能力。

---

## 6. 默认模板

| 等级 | 模板 ID | 默认授权 |
|---|---|---|
| L1 | `l1` | 全部节点，Scope 取该节点最宽值 |
| L2 | `l2` | 读子树、写本部门；知识可写可确认；审计可读子树 |
| L3 | `l3` | 本部门组织可见、知识可读、Skill/产线可用、本人资料可编辑 |

模板存 `role_templates / role_template_grants`；成员级覆盖存 `user_permission_grants`。

---

## 7. 保护区（硬编码，不进目录）

| Key | 中文名 | 说明 |
|---|---|---|
| `protected:secrets` | 密钥管理 | 模型密钥、部署密钥、内部签名密钥 |
| `protected:root_account` | 根账号管理 | 根账号与最后一个 L1 保护 |
| `protected:permission_grant` | 权限授权 | 修改角色模板与成员授权本身 |
| `protected:tenant` | 租户治理 | 租户策略、行业能力与升级 |
| `protected:protected_path` | 代码保护区 | 认证、成员、令牌、部署脚本等敏感路径 |

规则：只绑定 L1，不出现在配置面板，不能被任何授权覆盖。

---

## 8. 不变量（必须自动化测试）

1. `effective ⊆ ceiling(level)`。
2. 授予者只能授予自己拥有的节点，且授予 Scope ≤ 自己的 Scope。
3. 写类动作的 Scope 不含 `DEPT_TREE`。
4. 多任用按当前部门上下文解析，不全局合并。
5. `deny` 优先于 `allow`；未知节点默认拒绝。
6. 最后一个 L1 不可移出、不可停用、不可降级。
7. 保护区不可授权，不出现在目录 UI。
8. Pending Handover 账号无法登录、无法调用写接口。
9. 未启用模块没有节点、没有授权行、不出现在面板。

---

## 9. 数据模型

```text
role_templates            (id, name, level, is_system, sort_order)
role_template_grants      (template_id, permission_key, scope_type, effect)
user_permission_grants    (id, tenant_id, user_id, permission_key, scope_type,
                           scope_id, effect, granted_by, expires_at)
permission_revisions      (user_id, version, updated_at)
approval_requests         (id, tenant_id, type, subject_type, subject_id, requester_id,
                           status, payload, decided_at, decided_by)
handover_items            (id, approval_id, asset_type, asset_id, from_user_id,
                           to_user_id, transferred_at)
```

字段约束：

- `scope_type ∈ {ALL, DEPT_TREE, DEPT, SELF}`。
- `effect ∈ {allow, deny}`。
- `ALL / SELF` 的 `scope_id` 必须为空；`DEPT / DEPT_TREE` 必须非空。
- `user_permission_grants` 每个用户每个节点只保留一行，`effect` 决定允许或拒绝。
- `permission_key` 使用 text，新增模块不改表结构。

---

## 10. 扩展流程（后续接入财务 / 教学 / CRM）

1. 在 `PERMISSION_MODULES` 把对应模块 `enabled` 改为 `true`。
2. 在 `PERMISSION_NODES` 增加节点，声明动作、风险、Scope、默认值。
3. 在等级上限中决定 L2/L3 是否可见。
4. 在 `DEFAULT_TEMPLATE_SCOPES` 增加默认授权。
5. 在 `db/policies/010_permission_grants.sql` 增加模板行。
6. 在对应 API / Server Action 增加 `requirePermission`。
7. 如涉及资产交接，注册新的 `AssetAdapter`。
8. 增加测试：未授权拒绝、Scope 越界拒绝、模板生效。

> 不需要修改判定主流程、表结构或 UI 主体。

### 10.1 废弃节点

1. 先在 `PERMISSION_NODES` 标记废弃并停止下发（`DEFAULT_TEMPLATE_SCOPES` 移除）。
2. 保留旧 Key 至少一个版本，解析层忽略不存在的节点（已有 `ignoredKeys` 行为）。
3. 确认 `user_permission_grants` 中无有效引用后，再删除目录项与模板行。
4. 同步移除所有 `requirePermission` 调用点，守卫覆盖脚本必须无新增未覆盖入口。

### 10.2 重命名 Key

1. 禁止原地改名（会让历史授权静默失效）。
2. 按「新增 → 双写/双读 → 迁移授权行 → 废弃旧 Key」四步走。
3. 迁移脚本需在 `db/policies` 内幂等执行，且同时递增 `permission_revisions`。

---

## 11. 验收（P0–P7 定稿）

- 目录 25 个节点，每个都有中文名、风险、默认值、Scope。
- L1/L2/L3 上限是包含关系，且写动作不含 `DEPT_TREE`。
- 财务/教学/CRM 节点数为 0，模块 `enabled=false`。
- `npm run test:permissions`（155）与 `npm run test:permission-core`（40）全绿。
- P3–P6 落地证据：`test:rls 18`、`test:context 16`、`test:snapshot 17`、`test:permission-admin-db 14`。
- P7 落地证据：`test:handover 23`（创建 / 幂等 / 唯一 L1 / 通过 / 驳回 / 撤回 / 冻结登录）。
- 守卫覆盖：`npm run verify:guards` 无未覆盖入口（含审批中心共用包装函数的传递判定）。
- 迁移幂等：空库首轮 `applied_migrations=7 / applied_policies=14`，二次执行指纹不变。
