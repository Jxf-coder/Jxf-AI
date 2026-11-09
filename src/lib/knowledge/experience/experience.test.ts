/**
 * 经验沉淀纯函数单测（不依赖数据库）。
 * 运行：npm run test:experience
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SIMILARITY_MERGE,
  SIMILARITY_SUSPECT,
  classifySimilarity,
  cooldownBucket,
  jaccardSimilarity,
  manualBucket,
  numSignature,
} from "./dedupe";
import { MIN_SOURCE_CHARS, isCollectableText, prepareExperienceText } from "./capture";
import { buildPipelineSourceText } from "./collectors";
import { buildFingerprint, normalizeForFingerprint } from "./fingerprint";
import { redactText, redactValue } from "./redact";
import { routeFolder } from "./routing";
import { collapseRepeatedLines, truncateSourceText } from "./truncate";

const TENANT = "00000000-0000-4000-8000-000000000001";
const DEPT = "11111111-1111-4000-8000-111111111111";

test("normalizeForFingerprint 抹掉 UUID/时间戳，保留错误码与步骤名", () => {
  const raw = "2026-11-08T12:34:56Z run 3f2b8c1e-1111-4222-8333-444455556666 failed at step=extract status=500";
  const normalized = normalizeForFingerprint(raw);
  assert.ok(!normalized.includes("3f2b8c1e-1111-4222-8333-444455556666"));
  assert.ok(!normalized.includes("2026-11-08T12:34:56Z"));
  assert.ok(normalized.includes("step=extract"));
  assert.ok(normalized.includes("status=500"));
});

test("buildFingerprint 对同一故障稳定，对步骤/状态码变化而不同", () => {
  const base = {
    tenantId: TENANT,
    departmentId: DEPT,
    sourceType: "pipeline_run",
    step: "extract",
    errorType: "TimeoutError",
    statusCode: 500,
    text: "request 3f2b8c1e-1111-4222-8333-444455556666 timed out",
  };
  const same = { ...base, text: "request 99999999-1111-4222-8333-444455556666 timed out" };
  assert.equal(buildFingerprint(base), buildFingerprint(same));

  const otherStep = buildFingerprint({ ...base, step: "load" });
  const otherStatus = buildFingerprint({ ...base, statusCode: 504 });
  assert.notEqual(buildFingerprint(base), otherStep);
  assert.notEqual(buildFingerprint(base), otherStatus);
});

test("相似度阈值：≥0.92 合并、0.85–0.92 疑似、其余独立", () => {
  assert.equal(classifySimilarity(SIMILARITY_MERGE), "merge");
  assert.equal(classifySimilarity(SIMILARITY_SUSPECT), "suspect");
  assert.equal(classifySimilarity(0.5), "independent");

  assert.equal(jaccardSimilarity("同一条错误日志", "同一条错误日志"), 1);
  assert.ok(jaccardSimilarity("提取步骤超时", "上传文件失败") < SIMILARITY_SUSPECT);
});

test("冷却桶为 UTC 小时格式，手动桶可独立成 job", () => {
  assert.equal(cooldownBucket(new Date("2026-11-08T12:34:56Z")), "2026110812");
  assert.equal(cooldownBucket(new Date("2026-01-02T03:04:05Z")), "2026010203");
  assert.equal(manualBucket("abc"), "manual:abc");
});

test("numSignature 区分不同数字，避免标题骨架误合并", () => {
  const step2 = numSignature("产线在第 2 步失败，重试 3 次");
  const step3 = numSignature("产线在第 3 步失败，重试 3 次");
  assert.notEqual(step2, step3);
  assert.equal(numSignature("产线在第 2 步失败，重试 3 次"), step2);
});

test("去敏保留字段名/URL/状态码，只替换敏感值", () => {
  const output = redactText(
    "apiKey=abc123 error=timeout status=500 baseURL=https://api.example.com/v1?token=secretvalue",
  );
  assert.ok(output.includes("apiKey=***"));
  assert.ok(!output.includes("abc123"));
  assert.ok(output.includes("error=timeout"));
  assert.ok(output.includes("status=500"));
  assert.ok(output.includes("https://api.example.com/v1"));
  assert.ok(!output.includes("secretvalue"));
});

test("去敏覆盖 Bearer / sk- / jxf_mcp_ / 手机号 / 邮箱", () => {
  const output = redactText(
    "Authorization: Bearer abcdefgh12345678 sk-abcdefgh12345678 jxf_mcp_abcdefgh12345678 13800138000 user@example.com",
  );
  assert.ok(!output.includes("abcdefgh12345678"));
  assert.ok(!output.includes("13800138000"));
  assert.ok(!output.includes("user@example.com"));
});

test("递归去敏适用于 source_meta", () => {
  const output = redactValue({ step: "extract", error: "token=abc123", nested: ["phone=13800138000"] });
  assert.equal(output.step, "extract");
  assert.ok(output.error.includes("token=***"));
  assert.ok(output.nested[0].includes("phone=***"));
});

test("截断保留关键错误行、按行对齐且不超过上限", () => {
  const noise = Array.from({ length: 2000 }, (_, index) => `line ${index} 普通日志内容`).join("\n");
  const raw = `${noise}\nERROR failed at step=extract status=500 root cause timeout\n${noise}`;
  const result = truncateSourceText(raw, 2000);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 2000);
  assert.ok(result.text.includes("ERROR failed at step=extract status=500"));
  assert.ok(result.text.includes("[... omitted"));
  assert.ok(result.omittedChars > 0);
});

test("短文本不截断；重复行折叠并标注次数", () => {
  const short = truncateSourceText("ok", 2000);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "ok");

  const collapsed = collapseRepeatedLines(["a", "a", "a", "b"]);
  assert.deepEqual(collapsed, ["a  [x3]", "b"]);
});

test("路由：人工显式选择优先", () => {
  const result = routeFolder({
    channel: "document",
    kind: "fact",
    title: "产线失败根因",
    body: "失败原因",
    explicitFolder: "03-standards",
    sourceFolder: "05-distill",
  });
  assert.equal(result.folderKey, "03-standards");
  assert.equal(result.pending, false);
  assert.equal(result.suggestedFolder, null);
});

test("路由：文档目录可继承 05", () => {
  const result = routeFolder({
    channel: "document",
    kind: "fact",
    title: "任意标题",
    body: "任意正文",
    sourceFolder: "05-distill",
  });
  assert.equal(result.folderKey, "05-distill");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.pending, false);
});

test("路由：来源通道直接落 05", () => {
  const result = routeFolder({
    channel: "pipeline",
    kind: "fact",
    title: "产线第 2 步失败",
    body: "超时",
  });
  assert.equal(result.folderKey, "05-distill");
  assert.equal(result.confidence, 0.85);
});

test("路由：复盘报告落 08，普通复盘落 05", () => {
  assert.equal(
    routeFolder({ channel: "retro", kind: "viewpoint", title: "第 40 周周报", body: "本周进展" }).folderKey,
    "08-retro",
  );
  assert.equal(
    routeFolder({ channel: "retro", kind: "viewpoint", title: "项目复盘", body: "失败与教训" }).folderKey,
    "05-distill",
  );
});

test("路由：内容规则命中单一目录", () => {
  const result = routeFolder({
    channel: "document",
    kind: "fact",
    title: "数据备份规范",
    body: "必须每周执行并留档",
    sourceFolder: "01-original",
  });
  assert.equal(result.folderKey, "03-standards");
  assert.equal(result.pending, false);
});

test("路由：案例与复盘同时命中判冲突，标记待定", () => {
  const result = routeFolder({
    channel: "document",
    kind: "fact",
    title: "客户项目复盘",
    body: "交付经验",
    sourceFolder: "01-original",
  });
  assert.equal(result.pending, true);
  assert.equal(result.folderKey, "02-cards");
  assert.equal(result.suggestedFolder, null);
  assert.ok(result.reason.includes("规则冲突"));
});

test("路由：无信号默认 02 且不打扰", () => {
  const result = routeFolder({
    channel: "document",
    kind: "fact",
    title: "产品参数",
    body: "重量 1.2kg",
    sourceFolder: "01-original",
  });
  assert.equal(result.folderKey, "02-cards");
  assert.equal(result.pending, false);
  assert.equal(result.confidence, 0.7);
});

test("采集前统一去敏与截断：原文不落库", () => {
  const prepared = prepareExperienceText(
    `产线失败：apiKey=abc123 status=500\n${"正常日志内容".repeat(4000)}`,
  );
  assert.ok(prepared.text.includes("apiKey=***"));
  assert.ok(!prepared.text.includes("abc123"));
  assert.ok(prepared.text.includes("status=500"));
  assert.equal(prepared.truncated, true);
  assert.ok(prepared.text.length <= 12_000);
});

test("来源文本不足 200 字不采", () => {
  assert.equal(isCollectableText("太短"), false);
  assert.equal(isCollectableText("经".repeat(MIN_SOURCE_CHARS)), true);
});

test("产线来源文本包含失败步骤、验收备注与交付摘要", () => {
  const text = buildPipelineSourceText({
    pipelineName: "内容产线",
    triggerKind: "schedule",
    failedStep: "第 2 步：审核",
    skippedSteps: [],
    steps: [
      { title: "第 1 步：抽取", brief: "从文档中抽取要点" },
      { title: "第 2 步：审核", brief: "核对事实与数字" },
    ],
    workItems: [
      {
        id: "w1",
        title: "第 2 步：审核",
        brief: "核对事实与数字",
        status: "failed",
        review_note: "模型输出了无法核对的数字",
        text: "交付摘要正文",
      },
    ],
  });
  assert.ok(text.includes("失败于「第 2 步：审核」"));
  assert.ok(text.includes("验收备注：模型输出了无法核对的数字"));
  assert.ok(text.includes("交付摘要：交付摘要正文"));
  assert.ok(text.includes("触发方式：schedule"));
});
