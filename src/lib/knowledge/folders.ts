/**
 * 知识库 10 个标准业务目录。
 *
 * key 落库（documents.folder_key / knowledge_cards.folder_key），label 只用于展示；
 * 目录是「规范视图」而不是真实文件夹表：即使某个目录下没有数据，树里也会常驻该节点。
 */

export const STANDARD_FOLDERS = [
  { key: "00-agent-memory", label: "00-Agent记忆库" },
  { key: "01-original", label: "01-原始素材" },
  { key: "02-cards", label: "02-知识卡片" },
  { key: "03-standards", label: "03-标准规范" },
  { key: "04-cases", label: "04-案例库" },
  { key: "05-distill", label: "05-经验蒸馏" },
  { key: "06-templates", label: "06-模板工具" },
  { key: "07-training", label: "07-培训资料" },
  { key: "08-retro", label: "08-复盘归档" },
  { key: "99-trash", label: "99-回收站" },
] as const;

export type FolderKey = (typeof STANDARD_FOLDERS)[number]["key"];

export const FOLDER_KEYS: readonly FolderKey[] = STANDARD_FOLDERS.map((folder) => folder.key);

/** 文档默认落「01-原始素材」，卡片默认落「02-知识卡片」 */
export const DEFAULT_DOCUMENT_FOLDER: FolderKey = "01-original";
export const DEFAULT_CARD_FOLDER: FolderKey = "02-cards";

/** 岗位缺失时的兜底分组名 */
export const UNASSIGNED_ROLE = "未分配岗位";

export function isFolderKey(value: string | undefined | null): value is FolderKey {
  return typeof value === "string" && (FOLDER_KEYS as readonly string[]).includes(value);
}

export function folderLabel(key: string): string {
  return STANDARD_FOLDERS.find((folder) => folder.key === key)?.label ?? key;
}
