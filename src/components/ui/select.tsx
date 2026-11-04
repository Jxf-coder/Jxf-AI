"use client";

import type { SelectHTMLAttributes } from "react";

import { ChevronIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "onChange"> {
  options: readonly SelectOption[];
  onValueChange?: (value: string) => void;
}

/**
 * 全局唯一下拉框实现。
 *
 * - 原生 select 使用 appearance:none，彻底移除浏览器绘制的贴边箭头
 * - 右侧统一用 lucide ChevronDown 覆盖渲染，间距由 CSS 固定，不受浏览器差异影响
 * - 业务里的 <select> 必须走本组件，避免每个页面自定义圆角 / 背景 / 焦点环
 */
export function Select({ options, onValueChange, className, ...rest }: SelectProps) {
  return (
    <span className={["ui-select-wrap", className ?? ""].filter(Boolean).join(" ")}>
      <select
        className="ui-select"
        onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronIcon className="ui-select-chevron" size={14} />
    </span>
  );
}
