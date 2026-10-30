import { errorMessage, log } from "@/lib/logger";

/**
 * 进程级启动校验：环境变量不合法直接抛错退出，绝不允许带病启动。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { loadEnv } = await import("@/lib/env");

  try {
    const env = loadEnv();
    log("info", "service_start", {
      version: env.version,
      app_env: env.appEnv,
      node_version: process.version,
      log_level: env.logLevel,
      pid: process.pid,
    });
  } catch (error) {
    log("error", "env_validation_failed", { error: errorMessage(error) });
    // Next 会吞掉 instrumentation 的异常并继续监听端口，这里显式退出以保证 fail-closed
    process.exit(1);
  }
}
