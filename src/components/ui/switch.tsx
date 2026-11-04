"use client";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 无障碍名称，必填 */
  label: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * 全局唯一开关（iOS 风格）。
 *
 * 约束：任何开关 / Toggle 都必须使用本组件，禁止页面内自建 checkbox 样式。
 */
export function Switch({ checked, onChange, label, disabled = false, id, className }: SwitchProps) {
  return (
    <label
      className={["ui-switch", checked ? "is-on" : "", disabled ? "is-disabled" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
    </label>
  );
}
