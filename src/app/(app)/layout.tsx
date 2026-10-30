import { headers } from "next/headers";

import { Shell } from "@/components/shell/Shell";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;

  let accessLevel: string | null = null;
  try {
    const context = await resolveUserContext(user.userId, requestId);
    accessLevel = context.accessLevel;
  } catch (error) {
    log("error", "layout_context_failed", { error: errorMessage(error), request_id: requestId ?? null });
  }

  return (
    <Shell
      email={user.email}
      name={user.name}
      accessLevel={accessLevel}
      siteName={process.env.JXF_SITE_NAME?.trim() || "Jxf-AI"}
    >
      {children}
    </Shell>
  );
}
