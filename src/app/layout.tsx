import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Jxf-AI 工作台",
  description: "私有化交付的 AI 员工平台",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
