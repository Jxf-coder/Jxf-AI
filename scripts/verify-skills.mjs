/**
 * 技能与授权体检：把 test:skills 与 audit:grants 合成一个门禁步骤，
 * 保持 verify:delivery 仍是 10 个步骤。
 */
import { spawnSync } from "node:child_process";

import { ROOT } from "./lib/delivery.mjs";

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  { name: "技能注册与绑定", args: ["run", "test:skills"] },
  { name: "授权收口体检", args: ["run", "audit:grants"] },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n--- ${step.name} ---`);
  const result = spawnSync(NPM, step.args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    failed += 1;
  }
}

process.exit(failed === 0 ? 0 : 1);
