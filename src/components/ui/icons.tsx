import {
  Archive,
  Bell,
  Building2,
  ChevronDown,
  Inbox,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  User,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/**
 * 全局唯一图标出口。
 *
 * 约束：业务代码禁止再手写内联 <svg>；折叠箭头、关闭按钮、导航图标等
 * 一律从本文件导出，保证线宽 / 尺寸 / 语义在全系统一致。
 */
const DEFAULT_SIZE = 16;
const DEFAULT_STROKE_WIDTH = 1.75;

export function Icon({
  icon: Glyph,
  size = DEFAULT_SIZE,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  ...rest
}: LucideProps & { icon: LucideIcon }) {
  return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden {...rest} />;
}

type IconProps = Omit<LucideProps, "icon">;

/** 折叠 / 展开箭头（唯一实现，自带 is-open 旋转样式钩子） */
export function ChevronIcon(props: IconProps) {
  return <Icon icon={ChevronDown} {...props} />;
}

export function CloseIcon(props: IconProps) {
  return <Icon icon={X} {...props} />;
}

export function SearchIcon(props: IconProps) {
  return <Icon icon={Search} {...props} />;
}

export function MenuIcon(props: IconProps) {
  return <Icon icon={Menu} {...props} />;
}

export function SettingsIcon(props: IconProps) {
  return <Icon icon={Settings} {...props} />;
}

export function UserIcon(props: IconProps) {
  return <Icon icon={User} {...props} />;
}

export function ShieldIcon(props: IconProps) {
  return <Icon icon={ShieldCheck} {...props} />;
}

export function LogoutIcon(props: IconProps) {
  return <Icon icon={LogOut} {...props} />;
}

export function OrgIcon(props: IconProps) {
  return <Icon icon={Building2} {...props} />;
}

export function ArchiveIcon(props: IconProps) {
  return <Icon icon={Archive} {...props} />;
}

export function BellIcon(props: IconProps) {
  return <Icon icon={Bell} {...props} />;
}

export function InboxIcon(props: IconProps) {
  return <Icon icon={Inbox} {...props} />;
}
