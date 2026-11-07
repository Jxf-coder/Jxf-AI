/**
 * 设置面共享的运行时 AI 覆盖。
 *
 * 纯内存模块（不依赖数据库 / Next），由 env.ts 在解析 AI 配置时读取。
 * 启动期与保存后由 runtime-server 从数据库刷新；Web 进程热生效，
 * Worker 是独立进程，需要重启才能加载新配置。
 */

export interface AiRuntimeOverride {
  enabled?: boolean;
  baseUrl?: string;
  /** 已解密的明文 Key；仅存在于进程内存，禁止落日志 */
  apiKey?: string;
  chatModel?: string;
  fastModel?: string;
}

let current: AiRuntimeOverride | null = null;

export function getAiRuntimeOverride(): AiRuntimeOverride | null {
  return current;
}

export function setAiRuntimeOverride(next: AiRuntimeOverride | null): void {
  current = next;
}
