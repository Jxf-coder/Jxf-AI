"use client";

import type { SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "onChange"> {
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
}

/**
 * 全局唯一下拉框样式封装。
 *
 * 约束：业务里的 <select> 必须走本组件，避免每个页面自定义圆角 / 背景 / 焦点环。
 */
export function Select({ options, onValueChange, className, ...rest }: SelectProps) {
  return (
    <select
      className={["ui-select", className ?? ""].filter(Boolean).join(" ")}
      onChange={(event) => onValueChange(event.target.value)}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
