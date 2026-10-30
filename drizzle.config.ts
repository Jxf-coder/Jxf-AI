import { defineConfig } from "drizzle-kit";

// P1 起表定义写入 db/schema，迁移文件由 drizzle-kit 生成到 db/migrations。
// 本文件不参与 Next.js 构建，仅在本地或 CI 执行 drizzle-kit 时使用。
export default defineConfig({
  schema: "./db/schema",
  out: "./db/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? "",
  },
});
