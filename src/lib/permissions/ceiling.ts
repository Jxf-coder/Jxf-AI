/**
 * 等级上限：L1 / L2 / L3 各自最多能拿到哪些 PermissionNode。
 * 上限是硬规则，任何用户级授权都不能突破。
 */

import type { AccessLevel } from "@/types/profile";

import {
  LEVEL_CEILING,
  isWithinCeiling,
  type PermissionKey,
} from "./catalog";

export function ceilingFor(level: AccessLevel): readonly PermissionKey[] {
  return LEVEL_CEILING[level];
}

export function ceilingSet(level: AccessLevel): ReadonlySet<PermissionKey> {
  return new Set(LEVEL_CEILING[level]);
}

export { isWithinCeiling };
