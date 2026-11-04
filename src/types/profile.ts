/**
 * 个人资料与成员清单共用的标准数据结构。
 * 页面、Server Action、后续「成员清单 / 资产交接」均以这里为准，避免各处自定义形状。
 */

export type AccessLevel = "L1" | "L2" | "L3";

/** 多邮箱身份：一个成员可绑定多个业务/项目邮箱 */
export interface UserEmailIdentity {
  id: string;
  email: string;
  /** 默认主邮箱：系统发件 / CRM 消息的默认出口，同时作为登录邮箱 */
  isPrimary: boolean;
  /** 已验证时间；为空表示尚未完成验证 */
  verifiedAt: string | null;
  createdAt: string;
}

/** 成员的有效任用（部门 + 业务岗位 + 权限等级 + HR 档案） */
export interface UserMembershipSummary {
  id: string;
  departmentId: string;
  departmentName: string;
  title: string;
  accessLevel: AccessLevel;
  /** 工号：留空时由组织架构自动生成 JXF-0001 */
  employeeNo: string | null;
  /** 入职日期（YYYY-MM-DD） */
  hireDate: string | null;
  /** HR 岗位字段，与 title 同步 */
  position: string | null;
}

/** 个人资料聚合：核心身份 + 多邮箱 + 全部有效任用 */
export interface UserProfile {
  id: string;
  name: string;
  /** 主账号唯一标识 */
  phone: string | null;
  /** 头像：目前以 data URL 存储，后续可迁移到对象存储 */
  avatarUrl: string | null;
  /** 生日（YYYY-MM-DD） */
  birthday: string | null;
  createdAt: string;
  emails: UserEmailIdentity[];
  memberships: UserMembershipSummary[];
}

/** 当前操作者对目标资料的权限（由服务端计算，前端只用于展示） */
export interface ProfilePermissions {
  isSelf: boolean;
  canView: boolean;
  /** 头像 / 姓名 / 手机号 / 多邮箱：本人或上级可改 */
  canEditCore: boolean;
  /** 业务岗位：L1 全部；L2 仅下级 L3；L3 只读 */
  canEditTitle: boolean;
  /** 所属部门 / 权限等级：仅 L1 */
  canEditOrg: boolean;
  /** 生日：允许本人在个人资料页自助修改 */
  canEditBirthday: boolean;
}
