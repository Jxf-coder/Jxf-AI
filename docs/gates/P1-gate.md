# P1 人工闸门（Hard Gate）

> 阶段：Phase 1 · 组织治理 + 权限体系（含 P0–P8）
> 修订：2026-11-05（按当前信息架构重写；旧版路径 `/org/positions`、`/settings/permissions` 已改为兼容跳转）
> 验收主体：用户本人；AI 自评不算通过

## 交付物

- 组织：`departments` / `department_closure` / `memberships`（部门 + 业务岗位 + L1/L2/L3）/ `department_packs`
- 身份：`users`（手机号主账号 + 生日）/ `user_email_identities`（1:N 多邮箱）
- HR 档案：`memberships.employee_no / hire_date / position`（工号序列 `employee_no_seq`）
- 权限：`role_templates` / `role_template_grants` / `user_permission_grants` / `permission_revisions` / `approval_requests` / `handover_items`
- RLS 与函数：`db/policies/001–016`（`jxf_app` 非 owner / 非 superuser / 非 bypassrls）
- 审计：`audit_events`（`timestamp(3)` 毫秒精度，insert-only，按等级分级可见）
- 页面：`/login`、`/admin/organization`（组织架构 + 员工管理）、`/admin/permissions`（我的权限 / 角色管理 / 成员授权 / 审计日志）、`/me/profile`、`/me/approvals`
- 兼容跳转：`/org/positions`、`/settings/permissions`、`/me/permissions`、`/me/audit`
- 运维：Docker Compose 一键启动（web / caddy / migrate / postgres / minio），迁移幂等
- 测试：`test:rls`、`test:context`、`test:permissions`、`test:permission-core`、`test:snapshot`、`test:permission-admin-db`、`test:handover`、`verify:guards`

## 自动化证据（本次修订时通过）

```text
npm run test:rls                 → passed=33 failed=0
npm run test:context             → passed=16 failed=0
npm run test:permissions         → passed=155 failed=0
npm run test:permission-core     → passed=40  failed=0
npm run test:snapshot            → passed=17  failed=0
npm run test:permission-admin-db → passed=14  failed=0
npm run test:handover            → passed=23  failed=0
npm run verify:guards            → entries=29 covered=24 whitelisted=5 uncovered=0
npm run typecheck / build        → 0 Error
docker compose up                → migrate 8 条迁移 / 16 个策略，web healthy
移动端 390px（7 个页面）          → 横向溢出 0；员工表格卡片式；下拉框触控 36px
```

## 验收步骤（可照着点的路径）

> 入口固定为 `http://127.0.0.1`（`localhost` 会 308 跳转，避免会话跨主机名丢失）。
> 演示账号：`admin@jxf.local`；口令见 `.env` 的 `SEED_PASSWORD`。

- [ ] 1. 打开 `http://127.0.0.1/login` 登录，落地到 `/admin/organization`，顶栏显示当前身份
- [ ] 2. 组织架构 Tab：根节点「老板」下有「销售部」等子部门；成员名片显示 `[等级] 姓名 · 岗位`
- [ ] 3. 员工管理 Tab：列表含工号/部门/岗位/等级/状态列；切「已停用」显示空态，切回「在职」恢复
- [ ] 4. 新建部门：上级默认「老板」，只需填名称，无 slug 输入框；同名再建一次会自动生成 `-2` 后缀
- [ ] 5. 添加成员：姓名 + 手机号 + 岗位 + 等级，工号留空自动生成 `JXF-xxxx`；名片与列表同步
- [ ] 6. 编辑成员：可录入工号/入职日期/生日/岗位；点「详情」可见司龄按入职日期计算
- [ ] 7. 移出成员：弹页内确认弹窗（不是浏览器原生 confirm），确认后进入「已停用」，可「恢复账号」
- [ ] 8. 权限管理 → 角色管理：切换某个节点的作用域并保存，出现 Toast「角色权限已更新…下一次页面刷新生效」
- [ ] 9. 权限管理 → 成员授权：三态（继承/允许/拒绝）+ 作用域；审计日志 Tab 时间显示到秒、hover 显示毫秒、排序可切换
- [ ] 10. 个人资料：所属部门/权限等级仅 L1 可改；人事档案展示工号/入职日期/司龄/生日，生日本人可自助修改并保存成功

## 不通过项

- （待填写）

## 结论：待人工确认（2026-11-05）

> 完成上述 10 步后打 tag `gate/p1-passed`；未通过时只修复本文件列出的未通过项。
