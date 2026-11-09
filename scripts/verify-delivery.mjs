/**
 * M5 切片 2：一键验收清单。
 *
 *   npm run verify:delivery            # guards + typecheck + 冒烟 + 设置面 + 心跳 + 产线 + 邮件 + 指标 + 授权体检
 *   npm run verify:delivery -- --quick # 跳过 typecheck
 *
 * 不执行破坏性数据库测试（test:runtime 会清理测试租户数据），需要时单独运行。
 */
import { spawnSync } from "node:child_process";

import { ROOT } from "./lib/delivery.mjs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const quick = process.argv.includes("--quick");

const steps = [
  { name: "权限守卫覆盖", args: ["run", "verify:guards"] },
  ...(quick ? [] : [{ name: "TypeScript 类型检查", args: ["run", "typecheck"] }]),
  { name: "部署冒烟", args: ["run", "smoke"] },
  { name: "安装向导校验", args: ["run", "test:setup"] },
  { name: "设置面校验", args: ["run", "test:settings"] },
  { name: "连接器心跳校验", args: ["run", "test:mcp-health"] },
  { name: "自动化产线校验", args: ["run", "test:pipelines"] },
  { name: "邮件通知校验", args: ["run", "test:notifications"] },
  { name: "可观测性校验", args: ["run", "test:metrics"] },
  { name: "技能与授权体检", args: ["run", "verify:skills"] },
];

const results = [];

for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(NPM, step.args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    // Windows 上 npm 是 .cmd，必须经由 shell 启动
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`[verify:delivery] ${step.name} 启动失败：${result.error.message}`);
  }
  results.push({ name: step.name, ok: result.status === 0 });
}

console.log("\n=== 验收结果 ===");
for (const item of results) {
  console.log(`${item.ok ? "[PASS]" : "[FAIL]"} ${item.name}`);
}

const failed = results.filter((item) => !item.ok).length;
console.log(`\n[verify:delivery] ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
