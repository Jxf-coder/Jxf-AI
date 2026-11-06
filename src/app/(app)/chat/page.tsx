import { headers } from "next/headers";

import { headerRow, pageSubtitle, pageTitle, pageWrap } from "@/components/knowledge/tokens";
import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";

import { ChatClient } from "./ChatClient";

export default async function ChatPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const status = aiStatus();

  return (
    <section className={pageWrap}>
      <header className={headerRow}>
        <div>
          <h1 className={pageTitle}>AI 工作台</h1>
          <p className={pageSubtitle}>
            请求只负责受理并返回 run_id，长任务在 worker 中执行。页面按 seq 订阅事件流：
            断线重连只补缺口，关闭页面不会中止执行。
          </p>
        </div>
      </header>

      <ChatClient
        departmentName={context.activeDepartmentName}
        chatEnabled={status.chatEnabled}
        modelName={status.chatModel}
      />
    </section>
  );
}
