/**
 * worker 侧经验消费者：领取一个 job 并执行提炼。
 *
 * 与运行时队列共用同一个 worker 进程：
 * - 交互式 run 优先；无 run 可领时才处理经验 job，避免后台沉淀拖慢前台问答；
 * - 执行期间 30s 心跳续租，崩溃由 sweepExperienceJobs 回队列；
 * - 失败按尝试次数指数退避，3 次后进 dead。
 */

import type { Pool } from "pg";

import { errorMessage, log } from "@/lib/logger";

import { processExperienceJob } from "@/lib/knowledge/experience/process";
import {
  claimExperienceJob,
  failExperienceJob,
  heartbeatExperienceJob,
} from "@/lib/knowledge/experience/queue";

const HEARTBEAT_MS = 30_000;

/** 处理至多一个 job；返回 jobId，没有可处理项时返回 null */
export async function processOneExperienceJob(
  pool: Pool,
  workerId: string,
): Promise<string | null> {
  const job = await claimExperienceJob(pool, workerId);
  if (!job) {
    return null;
  }

  const heartbeat = setInterval(() => {
    void heartbeatExperienceJob(pool, job.id, workerId).catch((error) => {
      log("warn", "experience_heartbeat_failed", {
        job_id: job.id,
        error: errorMessage(error),
      });
    });
  }, HEARTBEAT_MS);

  try {
    const result = await processExperienceJob(pool, job);
    log("info", "experience_job_finished", {
      job_id: job.id,
      channel: job.channel,
      status: result.status,
      cards: result.cardIds.length,
      reason: result.reason ?? null,
    });
  } catch (error) {
    const next = await failExperienceJob(pool, job, errorMessage(error)).catch(() => "queued");
    log("warn", "experience_job_failed", {
      job_id: job.id,
      channel: job.channel,
      attempts: job.attempts,
      next,
      error: errorMessage(error),
    });
  } finally {
    clearInterval(heartbeat);
  }

  return job.id;
}
