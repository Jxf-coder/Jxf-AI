import type { ReactNode } from "react";

import { emptyState } from "./tokens";

/** 空态：统一的居中灰底提示 */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={emptyState}>{children}</p>;
}
