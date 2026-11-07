/**
 * MCP 连接器的 SSRF 防护。
 *
 * 规则：
 * - 只允许 http / https，禁止 URL 内嵌账号密码；
 * - 解析域名得到真实地址，命中内网 / 回环 / 链路本地 / 保留段即拒绝；
 * - 内网主机必须显式列入 MCP_TRUSTED_HOSTS（逗号分隔），这是私有化部署的显式放行口；
 * - 调用方必须禁止跟随重定向（见 connectors.ts），避免 302 绕过校验。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4ToInt(address: string): number {
  return address
    .split(".")
    .reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedV4(address: string): boolean {
  const value = ipv4ToInt(address);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedV6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  // IPv4-mapped：::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) {
    return isBlockedV4(mapped[1]);
  }
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("ff")
  );
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isBlockedV4(address);
  }
  if (version === 6) {
    return isBlockedV6(address);
  }
  return true;
}

export function trustedHosts(): string[] {
  return (process.env.MCP_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/** 校验连接器地址；不通过时抛错，绝不“记录后继续” */
export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("连接器地址不是合法 URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("连接器只支持 http / https");
  }
  if (url.username || url.password) {
    throw new Error("连接器地址不允许内嵌账号密码，请改用请求头或环境变量");
  }

  const host = hostOf(url);
  if (!host) {
    throw new Error("连接器地址缺少主机名");
  }
  if (trustedHosts().includes(host)) {
    return url;
  }

  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error(`无法解析连接器域名：${host}`);
      });

  for (const record of addresses) {
    if (isPrivateAddress(record.address)) {
      throw new Error(
        `连接器指向内网地址（${record.address}）。私有化部署请把主机加入 MCP_TRUSTED_HOSTS 白名单后再试`,
      );
    }
  }

  return url;
}
