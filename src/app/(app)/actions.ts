"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import {
  ACTIVE_DEPARTMENT_COOKIE,
  listActiveMemberships,
} from "@/lib/db/user-context";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * 切换当前部门上下文。
 * 只允许切到自己有效任用内的部门；Cookie 为 httpOnly，客户端无法伪造到其他部门。
 */
export async function switchActiveDepartment(formData: FormData): Promise<void> {
  const session = await requireSession();
  const targetDepartmentId = String(formData.get("departmentId") ?? "").trim();
  if (!targetDepartmentId) {
    return;
  }

  const memberships = await listActiveMemberships(session.userId);
  if (!memberships.some((membership) => membership.departmentId === targetDepartmentId)) {
    return;
  }

  const store = await cookies();
  store.set(ACTIVE_DEPARTMENT_COOKIE, targetDepartmentId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });

  revalidatePath("/", "layout");
}
