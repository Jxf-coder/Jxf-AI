import { pinyin } from "pinyin-pro";

/**
 * 由部门名称生成拼音 slug（仅内部使用，不出现在 UI）：
 * 「华东交付组」→ `hua-dong-jiao-fu-zu`。
 * 纯符号 / 空名称兜底为 `dept`，最终唯一性由调用方追加递增后缀。
 */
export function slugifyDepartmentName(name: string): string {
  const syllables = pinyin(name, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
  });

  const slug = syllables
    .join("-")
    .toLowerCase()
    .replace(/ü/g, "v")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "dept";
}
