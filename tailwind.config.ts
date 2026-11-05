import type { Config } from "tailwindcss";

/**
 * 设计令牌（FastGPT 风格 · Apple 极简）
 * - 主工作区纯白 / 二级导航冷灰 #f7f8fa
 * - 分割线极细：rgba(0,0,0,0.04)
 * - 激活态：浅蓝胶囊 #eff4ff + 苹果蓝字 #0071e3
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        apple: {
          blue: "#0071e3",
          "blue-hover": "#0077ed",
          "blue-soft": "#eff4ff",
          ink: "#1d1d1f",
          "ink-soft": "#3a3a3c",
          muted: "#86868b",
          canvas: "#f7f8fa",
        },
      },
      borderColor: {
        hairline: "rgba(0, 0, 0, 0.04)",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0, 0, 0, 0.03), 0 16px 40px -24px rgba(0, 0, 0, 0.18)",
        pill: "0 1px 2px rgba(0, 0, 0, 0.06)",
        "focus-blue": "0 0 0 3px rgba(0, 113, 227, 0.18)",
      },
    },
  },
};

export default config;
