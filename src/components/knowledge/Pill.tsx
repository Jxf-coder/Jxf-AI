import { badge, type Tone } from "./tokens";

interface PillProps {
  /** 语义色调，默认中性灰 */
  tone?: Tone;
  /** 选中态：浅蓝胶囊 + 苹果蓝字 */
  active?: boolean;
  children: React.ReactNode;
}

/** 胶囊标签：状态徽章与选中态共用 */
export function Pill({ tone = "muted", active = false, children }: PillProps) {
  return <span className={active ? badge("blue") : badge(tone)}>{children}</span>;
}
