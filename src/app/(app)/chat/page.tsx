import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { aiStatus } from "@/lib/ai/openai";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { isUuid } from "@/lib/knowledge/workspace";
import { listThreads, loadThread } from "@/lib/runtime/threads";

import { ChatClient } from "./ChatClient";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string | string[] }>;
}) {
  const session = await requireSession();
  const context = await resolveUserContext(session.userId);
  const status = aiStatus();

  const params = await searchParams;
  const requestedThreadId = Array.isArray(params.thread) ? params.thread[0] : params.thread;

  let threads = [] as Awaited<ReturnType<typeof listThreads>>;
  let thread = null as Awaited<ReturnType<typeof loadThread>>;
  let accessDenied = false;

  try {
    threads = await listThreads(context);
    if (requestedThreadId && isUuid(requestedThreadId)) {
      thread = await loadThread(context, requestedThreadId);
    }
  } catch {
    accessDenied = true;
  }

  if (accessDenied) {
    return (
      <section className="w-full py-2">
        <InlineMessage tone="error">当前账号没有「使用 Skill」权限，无法进入 Agent。</InlineMessage>
      </section>
    );
  }

  return (
    <ChatClient
      key={thread?.id ?? "new"}
      chatEnabled={status.chatEnabled}
      modelName={status.chatModel}
      fastModelName={status.fastModel}
      initialThreads={threads}
      initialThread={thread}
    />
  );
}
