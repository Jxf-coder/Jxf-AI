import { headers } from "next/headers";

import {
  emptyState,
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import { listOpsTasks } from "@/lib/ops/tasks";
import { getEffectiveAiSummary } from "@/lib/settings/ai";
import { readDeliveryStatus } from "@/lib/settings/delivery-status";
import { readPlatformSettings } from "@/lib/settings/store";

import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const header = (
    <header className={headerRow}>
      <div>
        <h1 className={pageTitle}>平台设置</h1>
        <p className={pageSubtitle}>
          品牌、模型 Key、邮件通知、审计留存与交付状态的统一入口。只有 L1 可以修改；
          所有变更都会写入审计日志。
        </p>
      </div>
    </header>
  );

  if (context.accessLevel !== "L1") {
    return (
      <section className={pageWrap}>
        {header}
        <div className={`mt-5 ${emptyState}`}>只有 L1 可以修改平台设置。</div>
      </section>
    );
  }

  const [settings, effective, opsTasks] = await Promise.all([
    readPlatformSettings(context),
    Promise.resolve(getEffectiveAiSummary()),
    listOpsTasks(context),
  ]);
  const delivery = readDeliveryStatus();
  const env = loadEnv();

  return (
    <section className={pageWrap}>
      {header}
      <p className="mt-3 text-[11px] text-zinc-500">
        版本 {env.version} · 运行环境 {env.appEnv} · 品牌与模型配置保存后即时生效，
        Worker 进程需重启加载新配置
      </p>
      <div className="mt-5">
        <SettingsClient
          settings={settings}
          effective={effective}
          delivery={delivery}
          opsTasks={opsTasks}
          version={env.version}
          appEnv={env.appEnv}
        />
      </div>
    </section>
  );
}
