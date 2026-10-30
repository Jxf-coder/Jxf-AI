import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
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
          const email =
            typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
          const password = typeof credentials?.password === "string" ? credentials.password : "";

          if (!email || !password) {
            return null;
          }

          try {
            const rows = await db
              .select({
                id: users.id,
                email: users.email,
                name: users.name,
                passwordHash: users.passwordHash,
              })
              .from(users)
              .where(eq(users.email, email))
              .limit(1);

            const user = rows[0];
            if (!user?.passwordHash) {
              return null;
            }

            if (!(await verifyPassword(password, user.passwordHash))) {
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
