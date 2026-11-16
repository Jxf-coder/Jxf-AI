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

/**
 * 事实问答的召回目录白名单。
 *
 * 05-经验蒸馏 / 08-复盘归档 是「经验与总结」，不是可引用的事实依据，
 * 必须在事实问答里显式排除；经验检索通道另行传 {05-distill}（可选加 08）。
 */
export const FACT_FOLDERS: readonly FolderKey[] = [
  "02-cards",
  "03-standards",
  "04-cases",
  "06-templates",
  "07-training",
];

export function isFolderKey(value: string | undefined | null): value is FolderKey {
  return typeof value === "string" && (FOLDER_KEYS as readonly string[]).includes(value);
}

/**
 * 产线可声明的归档目录：只允许语义目录，01/02/99 属于原始素材、默认卡片与回收站，
 * 不能作为产线交付物的强制归档目标。
 */
export const ARCHIVE_FOLDERS: readonly FolderKey[] = [
  "03-standards",
  "04-cases",
  "05-distill",
  "06-templates",
  "07-training",
  "08-retro",
];

export function isArchiveFolder(value: string | undefined | null): value is FolderKey {
  return typeof value === "string" && (ARCHIVE_FOLDERS as readonly string[]).includes(value);
}

/** 99-回收站只能由删除动作产生，不能作为上传目标 */
export function isUploadableFolder(value: string | undefined | null): value is FolderKey {
  return isFolderKey(value) && value !== "99-trash";
}

export function folderLabel(key: string): string {
  return STANDARD_FOLDERS.find((folder) => folder.key === key)?.label ?? key;
}
