/** 知识卡的中文标签与派生判断，供列表 / 表单复用 */

export const CARD_KIND_LABEL: Record<string, string> = {
  fact: "事实",
  object: "对象",
  decision: "决策",
  preference: "偏好",
  faq: "问答",
  case: "案例",
  viewpoint: "观点",
};

export const CARD_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  dropped: "已丢弃",
};

export const CARD_ORIGIN_LABEL: Record<string, string> = {
  intake: "巡读",
  distill: "AI 蒸馏",
  manual: "人工",
  scout: "采集",
};

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
