"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  emptyState,
  formGrid,
  input,
  meta,
} from "@/components/knowledge/tokens";
import type { DistributeView } from "@/lib/skills/distribute";

import {
  createAccountAction,
  createGroupAction,
  createJobAction,
  deleteGroupAction,
  retryJobAction,
  rotateRunnerTokenAction,
} from "../actions";

const PLATFORMS = [
  { id: "douyin", label: "抖音" },
  { id: "channels", label: "视频号" },
  { id: "xhs", label: "小红书" },
  { id: "kuaishou", label: "快手" },
  { id: "bilibili", label: "B站" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
];

const STATUS_LABEL: Record<string, string> = {
  queued: "已入队",
  scheduled: "定时",
  running: "进行中",
  done: "成功",
  error: "失败",
};

interface DistributePanelProps {
  view: DistributeView;
  canManage: boolean;
}

export function DistributePanel({ view, canManage }: DistributePanelProps) {
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runnerToken, setRunnerToken] = useState<string | null>(null);

  const [groupName, setGroupName] = useState("");
  const [account, setAccount] = useState({
    groupId: view.groups[0]?.id ?? "",
    platform: "douyin",
    displayName: "",
    hostname: "",
  });
  const [job, setJob] = useState({
    title: "",
    body: "",
    tags: "",
    platforms: ["douyin"] as string[],
    runAt: "",
    aiGenerated: false,
  });

  async function run(label: string, task: () => Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }>) {
    setBusy(label);
    setMessage(null);
    try {
      const result = await task();
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        if (typeof result.data?.token === "string") setRunnerToken(result.data.token);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  function togglePlatform(platform: string) {
    setJob((prev) => ({
      ...prev,
      platforms: prev.platforms.includes(platform)
        ? prev.platforms.filter((item) => item !== platform)
        : [...prev.platforms, platform],
    }));
  }

  return (
    <div className="space-y-4">
      {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}

      <SectionCard title="账号分组" count={`${view.groups.length} 组`} desc="国内与海外可各指定一台发布机；登录仍在发布机本机完成。">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="新分组名称">
            <input
              className={`${input} max-w-xs`}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder="例如：品牌号一组"
            />
          </Field>
          <button
            type="button"
            className={btnBlue}
            disabled={busy === "group" || groupName.trim().length === 0}
            onClick={() =>
              run("group", async () => {
                const result = await createGroupAction({ name: groupName });
                if (result.ok) setGroupName("");
                return result;
              })
            }
          >
            新建分组
          </button>
        </div>
        <ul className="mt-4 space-y-2">
          {view.groups.map((group) => (
            <li key={group.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-apple-canvas px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-zinc-900">{group.name}</span>
                <span className={badge("muted")}>{group.accountCount} 个账号</span>
                {group.laneCn ? <span className={meta}>国内 {group.laneCn}</span> : null}
                {group.laneOverseas ? <span className={meta}>海外 {group.laneOverseas}</span> : null}
              </div>
              <button
                type="button"
                className={btnGhost}
                disabled={busy === group.id}
                onClick={() => run(group.id, () => deleteGroupAction(group.id))}
              >
                删除
              </button>
            </li>
          ))}
          {view.groups.length === 0 ? (
            <li className={emptyState}>先在左侧建分组，再添加抖音 / 视频号 / 小红书等账号。</li>
          ) : null}
        </ul>
      </SectionCard>

      <SectionCard title="账号" count={`${view.accounts.length} 个`}>
        <div className={formGrid}>
          <Field label="所属分组">
            <select
              className={input}
              value={account.groupId}
              onChange={(event) => setAccount({ ...account, groupId: event.target.value })}
            >
              {view.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="平台">
            <select
              className={input}
              value={account.platform}
              onChange={(event) => setAccount({ ...account, platform: event.target.value })}
            >
              {PLATFORMS.map((platform) => (
                <option key={platform.id} value={platform.id}>
                  {platform.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="账号名称">
            <input
              className={input}
              value={account.displayName}
              onChange={(event) => setAccount({ ...account, displayName: event.target.value })}
              placeholder="例如：Jxf AI 官方号"
            />
          </Field>
          <Field label="发布机（可选）">
            <input
              className={input}
              value={account.hostname}
              onChange={(event) => setAccount({ ...account, hostname: event.target.value })}
              placeholder="例如：changsha-mac-mini"
            />
          </Field>
        </div>
        <div className={actions}>
          <button
            type="button"
            className={btnBlue}
            disabled={busy === "account" || !account.groupId || account.displayName.trim().length === 0}
            onClick={() =>
              run("account", async () => {
                const result = await createAccountAction(account);
                if (result.ok) setAccount({ ...account, displayName: "", hostname: "" });
                return result;
              })
            }
          >
            添加账号
          </button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>平台</th>
                <th>账号</th>
                <th>分组</th>
                <th>发布机</th>
                <th>登录</th>
              </tr>
            </thead>
            <tbody>
              {view.accounts.map((item) => (
                <tr key={item.id}>
                  <td>{PLATFORMS.find((platform) => platform.id === item.platform)?.label ?? item.platform}</td>
                  <td>{item.displayName}</td>
                  <td className="text-[12px] text-zinc-500">
                    {view.groups.find((group) => group.id === item.groupId)?.name ?? "—"}
                  </td>
                  <td className="text-[12px] text-zinc-500">{item.hostname ?? "—"}</td>
                  <td>
                    <span className={badge(item.loggedIn ? "ok" : "muted")}>
                      {item.loggedIn ? "已登录" : "待登录"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="发布" desc="一条成片一次生成九平台文案副本；立即入队或定时。">
        <div className="grid gap-3.5">
          <Field label="标题">
            <input
              className={input}
              value={job.title}
              onChange={(event) => setJob({ ...job, title: event.target.value })}
              placeholder="成片标题"
            />
          </Field>
          <Field label="正文">
            <textarea
              className={`${input} min-h-[100px]`}
              value={job.body}
              onChange={(event) => setJob({ ...job, body: event.target.value })}
              placeholder="口播原稿或发布正文"
            />
          </Field>
          <Field label="话题（空格分开，不用写 #）">
            <input
              className={input}
              value={job.tags}
              onChange={(event) => setJob({ ...job, tags: event.target.value })}
              placeholder="AI 员工 私有化 工作台"
            />
          </Field>
          <div>
            <p className={meta}>勾选要发的平台</p>
            <div className="mt-2 flex flex-wrap gap-3">
              {PLATFORMS.map((platform) => (
                <label key={platform.id} className="inline-flex items-center gap-1.5 text-[12px] text-zinc-600">
                  <input
                    type="checkbox"
                    checked={job.platforms.includes(platform.id)}
                    onChange={() => togglePlatform(platform.id)}
                  />
                  {platform.label}
                </label>
              ))}
            </div>
          </div>
          <div className={formGrid}>
            <Field label="定时发布（可选）">
              <input
                className={input}
                type="datetime-local"
                value={job.runAt}
                onChange={(event) => setJob({ ...job, runAt: event.target.value })}
              />
            </Field>
            <label className="mt-6 inline-flex items-center gap-2 text-[12px] text-zinc-600">
              <input
                type="checkbox"
                checked={job.aiGenerated}
                onChange={(event) => setJob({ ...job, aiGenerated: event.target.checked })}
              />
              这条片用了人工智能生成
            </label>
          </div>
        </div>
        <div className={actions}>
          <button
            type="button"
            className={btnBlue}
            disabled={busy === "job" || job.title.trim().length === 0 || job.platforms.length === 0}
            onClick={() =>
              run("job", async () => {
                const result = await createJobAction({
                  title: job.title,
                  body: job.body,
                  tags: job.tags.split(/\s+/).filter(Boolean),
                  platforms: job.platforms,
                  runAt: job.runAt || null,
                  aiGenerated: job.aiGenerated,
                });
                if (result.ok) setJob({ ...job, title: "", body: "", tags: "", runAt: "" });
                return result;
              })
            }
          >
            {job.runAt ? "定时发布" : "立即发布"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="任务" count={`${view.jobs.length} 条`}>
        {view.jobs.length === 0 ? (
          <div className={emptyState}>还没有任务。</div>
        ) : (
          <ul className="space-y-2">
            {view.jobs.map((item) => (
              <li key={item.id} className="rounded-xl bg-apple-canvas px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-medium text-zinc-900">{item.title}</p>
                    <p className={`mt-1 ${meta}`}>
                      {item.platforms.join(" / ")} · {new Date(item.createdAt).toLocaleString("zh-CN")}
                      {item.aiGenerated ? " · AI 生成" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={badge(
                        item.status === "done" ? "ok" : item.status === "error" ? "error" : item.status === "running" ? "blue" : "warn",
                      )}
                    >
                      {STATUS_LABEL[item.status] ?? item.status}
                    </span>
                    {item.status === "error" ? (
                      <button
                        type="button"
                        className={btnGhost}
                        disabled={busy === item.id}
                        onClick={() => run(item.id, () => retryJobAction(item.id))}
                      >
                        重试
                      </button>
                    ) : null}
                  </div>
                </div>
                {item.error ? <p className="mt-1 text-[12px] text-rose-600">{item.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="发布机令牌"
        desc="发布机用这个令牌领取任务并回写结果；服务端不保存平台口令。"
        right={<span className={badge(view.runnerTokenHint ? "ok" : "muted")}>{view.runnerTokenHint ?? "未生成"}</span>}
      >
        {canManage ? (
          <div className={actions}>
            <button
              type="button"
              className={btnGhost}
              disabled={busy === "token"}
              onClick={() => run("token", () => rotateRunnerTokenAction())}
            >
              生成 / 重置令牌
            </button>
          </div>
        ) : (
          <p className={meta}>仅 L1 可生成或重置发布机令牌。</p>
        )}
        {runnerToken ? (
          <div className="mt-3 rounded-xl bg-apple-canvas px-3.5 py-3">
            <p className={meta}>仅展示这一次，请立即保存到发布机：</p>
            <p className="mt-1 break-all font-mono text-[12px] text-zinc-900">{runnerToken}</p>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
