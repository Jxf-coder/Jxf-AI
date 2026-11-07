/**
 * 交付状态（只读）：把备份 / 升级脚本落在 backups/ 的产物可视化。
 *
 * Web 容器通过只读挂载看到宿主机 backups/ 目录；
 * 未挂载或没有备份时如实显示「暂无」，不伪造状态。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const BACKUP_DIR =
  process.env.JXF_BACKUP_DIR ??
  (process.env.NODE_ENV === "production" ? "/app/backups" : path.join(process.cwd(), "backups"));

const MAX_BACKUPS = 5;

export interface BackupSummary {
  name: string;
  createdAt: string | null;
  cold: boolean;
  appVersion: string | null;
  dbVersion: string | null;
  totalBytes: number;
  counts: Record<string, number>;
}

export interface UpgradeSummary {
  file: string;
  startedAt: string | null;
  status: string;
  backupDir: string | null;
  nextDbVersion: string | null;
  error: string | null;
  rolledBackAt: string | null;
}

export interface DeliveryStatus {
  backupDir: string;
  available: boolean;
  backups: BackupSummary[];
  lastUpgrade: UpgradeSummary | null;
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function backupSummary(name: string): BackupSummary | null {
  const manifest = readJsonFile(path.join(BACKUP_DIR, name, "manifest.json"));
  if (!manifest) {
    return null;
  }

  const files = (manifest.files ?? {}) as Record<string, { bytes?: number }>;
  const totalBytes = Object.values(files).reduce(
    (sum, item) => sum + (typeof item?.bytes === "number" ? item.bytes : 0),
    0,
  );
  const dbVersion = manifest.db_version as { version?: string } | null | undefined;
  const counts = (manifest.counts ?? {}) as Record<string, number>;

  return {
    name,
    createdAt: asText(manifest.created_at),
    cold: manifest.cold === true,
    appVersion: asText(manifest.app_version),
    dbVersion: dbVersion?.version ?? null,
    totalBytes,
    counts,
  };
}

function upgradeSummary(name: string): UpgradeSummary | null {
  const state = readJsonFile(path.join(BACKUP_DIR, name));
  if (!state) {
    return null;
  }
  const nextDb = state.next_db_version as { version?: string } | null | undefined;
  return {
    file: name,
    startedAt: asText(state.started_at),
    status: asText(state.status) ?? "unknown",
    backupDir: asText(state.backup_dir),
    nextDbVersion: nextDb?.version ?? null,
    error: asText(state.error),
    rolledBackAt: asText(state.rolled_back_at),
  };
}

export function readDeliveryStatus(): DeliveryStatus {
  if (!existsSync(BACKUP_DIR)) {
    return { backupDir: BACKUP_DIR, available: false, backups: [], lastUpgrade: null };
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(BACKUP_DIR);
  } catch {
    return { backupDir: BACKUP_DIR, available: false, backups: [], lastUpgrade: null };
  }

  const backups = entries
    .filter((name) => name.startsWith("backup-") && existsSync(path.join(BACKUP_DIR, name, "manifest.json")))
    .sort()
    .reverse()
    .slice(0, MAX_BACKUPS)
    .flatMap((name) => {
      const summary = backupSummary(name);
      return summary ? [summary] : [];
    });

  const upgradeFile = entries
    .filter((name) => name.startsWith("upgrade-") && name.endsWith(".json"))
    .sort()
    .at(-1);

  return {
    backupDir: BACKUP_DIR,
    available: true,
    backups,
    lastUpgrade: upgradeFile ? upgradeSummary(upgradeFile) : null,
  };
}
