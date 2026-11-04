import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { accounts, sessions, users, verificationTokens } from "@db/schema";
import { auditStandalone } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db/drizzle";
import { errorMessage, log } from "@/lib/logger";

/**
 * Auth.js v5 + Drizzle Adapter。
 * 会话策略为 JWT（Credentials 的官方限制），但每个请求都会重新解析任用，
 * 因此离岗后下一次请求立即 0 行，不依赖 token 过期。
 */
function buildAuthConfig(): NextAuthConfig {
  const db = getDb();

  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    session: {
      strategy: "jwt",
      maxAge: 8 * 60 * 60,
    },
    secret: process.env.JXF_AUTH_SECRET,
    trustHost: true,
    pages: {
      signIn: "/login",
    },
    providers: [
      Credentials({
        name: "账号密码",
        credentials: {
          email: { label: "邮箱", type: "email" },
          password: { label: "密码", type: "password" },
        },
        async authorize(credentials, request) {
          const identifier =
            typeof credentials?.email === "string" ? credentials.email.trim() : "";
          const password = typeof credentials?.password === "string" ? credentials.password : "";

          if (!identifier || !password) {
            return null;
          }

          const isEmail = identifier.includes("@");
          const email = identifier.toLowerCase();
          const phone = identifier.replace(/[\s-]/g, "");

          try {
            const rows = await db
              .select({
                id: users.id,
                email: users.email,
                name: users.name,
                status: users.status,
                passwordHash: users.passwordHash,
              })
              .from(users)
              .where(isEmail ? eq(users.email, email) : eq(users.phone, phone))
              .limit(1);

            const user = rows[0];
            if (!user?.passwordHash) {
              return null;
            }

            if (!(await verifyPassword(password, user.passwordHash))) {
              return null;
            }

            // 离职交接中 / 已停用：即使密码正确也拒绝登录
            if (user.status !== "active") {
              log("warn", "auth_login_denied_account_status", {
                user_id: user.id,
                status: user.status,
              });
              return null;
            }

            // 被移出（软删除 status = 'removed'）且没有其他有效任用的账号拒绝登录，
            // 与页面侧的 fail-closed 保持一致；恢复任用后即可再次登录。
            const membershipResult = await db.execute(
              sql`select app.user_department_ids(${user.id}::uuid) as department_ids`,
            );
            const departmentIds =
              (membershipResult.rows[0]?.department_ids as string[] | null) ?? [];
            if (departmentIds.length === 0) {
              log("warn", "auth_login_denied_no_membership", { user_id: user.id });
              return null;
            }

            await auditStandalone({
              actorUserId: user.id,
              action: "auth.login",
              targetType: "user",
              targetId: user.id,
              requestId: request?.headers.get("x-request-id") ?? null,
            });

            return { id: user.id, email: user.email, name: user.name ?? null };
          } catch (error) {
            log("error", "auth_authorize_failed", { error: errorMessage(error) });
            return null;
          }
        },
      }),
    ],
    callbacks: {
      jwt({ token, user }) {
        if (user?.id) {
          token.uid = user.id;
        }
        return token;
      },
      session({ session, token }) {
        if (typeof token.uid === "string" && session.user) {
          session.user.id = token.uid;
        }
        return session;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildAuthConfig());
