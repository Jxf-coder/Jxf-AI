/**
 * CRM 业务字典：类型标识与客户字段的固定映射。
 *
 * 设置页用它把英文类型显示成中文，客户表单用同一份映射渲染下拉；
 * 页面与客户端组件都可直接引用（纯数据，无副作用）。
 */

export interface CrmDictionaryOption {
  code: string;
  label: string;
}

export interface CrmDictionaryFieldOptions {
  grade: CrmDictionaryOption[];
  customerType: CrmDictionaryOption[];
  source: CrmDictionaryOption[];
  region: CrmDictionaryOption[];
  country: CrmDictionaryOption[];
}

export const CRM_DICTIONARY_TYPES: {
  key: string;
  field: keyof CrmDictionaryFieldOptions;
  label: string;
}[] = [
  { key: "customer_grade", field: "grade", label: "客户等级" },
  { key: "customer_type", field: "customerType", label: "客户类型" },
  { key: "customer_source", field: "source", label: "客户来源" },
  { key: "customer_region", field: "region", label: "区域" },
  { key: "customer_country", field: "country", label: "国家 / 地区" },
];

export function emptyCrmDictionaryOptions(): CrmDictionaryFieldOptions {
  return { grade: [], customerType: [], source: [], region: [], country: [] };
}

/** 把 trade_dictionaries 的行按字段归组；未知类型直接忽略 */
export function buildCrmDictionaryOptions(
  rows: { dict_type: string; code: string; label: string }[],
): CrmDictionaryFieldOptions {
  const options = emptyCrmDictionaryOptions();
  const byType = new Map(CRM_DICTIONARY_TYPES.map((type) => [type.key, type.field]));
  for (const row of rows) {
    const field = byType.get(row.dict_type);
    if (!field) {
      continue;
    }
    options[field].push({ code: row.code, label: row.label });
  }
  return options;
}
