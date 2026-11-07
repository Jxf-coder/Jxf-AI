interface BrandMarkProps {
  /** 站点后缀文案，默认「AI 工作台」 */
  label?: string;
  size?: "sm" | "md";
}

/**
 * 全站统一站点标识：品牌图形 + 站点名。
 * 图形资源统一放在 public/brand/，后续站点图片一并加入该目录。
 */
export function BrandMark({ label = "AI 工作台", size = "md" }: BrandMarkProps) {
  return (
    <span className={`brand-mark brand-mark-${size}`}>
      <img className="brand-mark-logo" src="/brand/fxf-mark.svg" alt="" aria-hidden="true" />
      <span className="brand-mark-text">{label}</span>
    </span>
  );
}
