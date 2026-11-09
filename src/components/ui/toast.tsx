"use client";

import { useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  leaving: boolean;
}

type ToastListener = (item: ToastItem) => void;

const listeners = new Set<ToastListener>();
let nextId = 1;

/** 全局轻提示：悬浮页面顶部居中，3 秒后淡出，点击立即消失，不占布局空间 */
export function toast(message: string, tone: ToastTone = "success"): void {
  if (!message) {
    return;
  }
  const item: ToastItem = { id: nextId++, message, tone, leaving: false };
  listeners.forEach((listener) => listener(item));
}

const TONE_CLASS: Record<ToastTone, string> = {
  success: "toast-success",
  error: "toast-error",
  info: "toast-info",
};

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>[]>());

  useEffect(() => {
    function clearItem(id: number) {
      const pending = timers.current.get(id) ?? [];
      pending.forEach(clearTimeout);
      timers.current.delete(id);
    }

    function dismiss(id: number) {
      clearItem(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    }

    function handle(item: ToastItem) {
      setItems((prev) => [...prev.slice(-2), item]);
      const exitTimer = setTimeout(() => {
        setItems((prev) =>
          prev.map((row) => (row.id === item.id ? { ...row, leaving: true } : row)),
        );
        const removeTimer = setTimeout(() => dismiss(item.id), 220);
        timers.current.set(item.id, [removeTimer]);
      }, 3000);
      timers.current.set(item.id, [exitTimer]);
    }

    listeners.add(handle);
    return () => {
      listeners.delete(handle);
      timers.current.forEach((pending) => pending.forEach(clearTimeout));
      timers.current.clear();
    };
  }, []);

  // 点击页面任意位置（含轻提示本身）立即收起
  useEffect(() => {
    if (items.length === 0) {
      return;
    }
    function handleClick() {
      timers.current.forEach((pending) => pending.forEach(clearTimeout));
      timers.current.clear();
      setItems([]);
    }
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [items.length]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div aria-live="polite" className="toast-layer">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`toast ${TONE_CLASS[item.tone]} ${item.leaving ? "is-leaving" : ""}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
