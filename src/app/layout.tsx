import type { Metadata } from "next";

import { ensureRuntimeSettings } from "@/lib/settings/runtime-server";
import { getPublicBranding } from "@/lib/settings/store";

import "./globals.css";

// 品牌来自数据库，允许管理端保存后无需重建即可生效
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getPublicBranding();
  return {
    title: branding.siteName,
    description: branding.siteTagline,
    icons: { icon: "/brand/fxf-mark.svg" },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // 首个页面请求前应用数据库中的模型配置（Web 进程热生效）
  await ensureRuntimeSettings();
  const branding = await getPublicBranding();
  // 色值已在服务端校验为 #RRGGBB，可安全内联
  const brandCss = [
    ":root{",
    `--brand-500:${branding.brandPrimary};`,
    `--brand-700:${branding.brandStrong};`,
    `--brand-900:${branding.brandDeep};`,
    `--brand-100:${branding.brandSoft};`,
    `--active-bg:${branding.brandSoft};`,
    "}",
  ].join("");

  return (
    <html lang="zh-CN">
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
