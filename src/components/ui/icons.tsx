import {
  Archive,
  Bell,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Inbox,
  Layers,
  LogOut,
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Plug,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Trash2,
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

/** 目录树的行内展开箭头（朝右，展开后由调用方旋转 90°） */
export function ChevronRightIcon(props: IconProps) {
  return <Icon icon={ChevronRight} {...props} />;
}

export function FolderIcon(props: IconProps) {
  return <Icon icon={Folder} {...props} />;
}

export function FileTextIcon(props: IconProps) {
  return <Icon icon={FileText} {...props} />;
}

export function LayersIcon(props: IconProps) {
  return <Icon icon={Layers} {...props} />;
}

export function SkillIcon(props: IconProps) {
  return <Icon icon={Puzzle} {...props} />;
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

export function KnowledgeIcon(props: IconProps) {
  return <Icon icon={BookOpen} {...props} />;
}

/** AI 员工目录 */
export function AiIcon(props: IconProps) {
  return <Icon icon={Bot} {...props} />;
}

/** MCP 连接器 */
export function PlugIcon(props: IconProps) {
  return <Icon icon={Plug} {...props} />;
}

/** Agent（运行时会话） */
export function ChatIcon(props: IconProps) {
  return <Icon icon={MessageSquare} {...props} />;
}

/** 会话操作菜单 */
export function MoreIcon(props: IconProps) {
  return <Icon icon={MoreHorizontal} {...props} />;
}

export function PinIcon(props: IconProps) {
  return <Icon icon={Pin} {...props} />;
}

export function ShareIcon(props: IconProps) {
  return <Icon icon={Share2} {...props} />;
}

export function EditIcon(props: IconProps) {
  return <Icon icon={Pencil} {...props} />;
}

export function TrashIcon(props: IconProps) {
  return <Icon icon={Trash2} {...props} />;
}

export function PlusIcon(props: IconProps) {
  return <Icon icon={Plus} {...props} />;
}

/** 附件上传 */
export function AttachmentIcon(props: IconProps) {
  return <Icon icon={Paperclip} {...props} />;
}

/** 语音输入 */
export function MicIcon(props: IconProps) {
  return <Icon icon={Mic} {...props} />;
}

/** 语音输入（录音中） */
export function MicOffIcon(props: IconProps) {
  return <Icon icon={MicOff} {...props} />;
}

/** 重做 / 重新生成 */
export function RefreshIcon(props: IconProps) {
  return <Icon icon={RefreshCw} {...props} />;
}

/** 复制 */
export function CopyIcon(props: IconProps) {
  return <Icon icon={Copy} {...props} />;
}

/** 复制成功 */
export function CheckIcon(props: IconProps) {
  return <Icon icon={Check} {...props} />;
}
