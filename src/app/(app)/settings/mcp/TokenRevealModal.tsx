"use client";

import { useState } from "react";

import { btnBlue, btnGhost, input, linkBtn, meta } from "@/components/knowledge/tokens";
import { toast } from "@/components/ui/toast";

interface TokenRevealModalProps {
  token: string;
  /** 仅在已复制或用户在二次确认中选择「确认关闭」后调用 */
  onClose: () => void;
}

/**
 * 新令牌明文弹窗：全局居中展示，强制确认复制状态。
 * 未点击「复制令牌」时，任何关闭入口都会先弹出二次确认。
 */
export function TokenRevealModal({ token, onClose }: TokenRevealModalProps) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setCopyFailed(false);
      toast("已复制到剪贴板");
      return;
    } catch {
      // 剪贴板受限时退回选区复制
    }
    const field = document.getElementById("issued-token-plaintext") as HTMLInputElement | null;
    field?.focus();
    field?.select();
    try {
      if (document.execCommand("copy")) {
        setCopied(true);
        setCopyFailed(false);
        toast("已复制到剪贴板");
        return;
      }
    } catch {
      // 忽略，下面统一提示
    }
    setCopyFailed(true);
  }

  function requestClose() {
    if (!copied) {
      setConfirming(true);
      return;
    }
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button
          type="button"
          aria-label="关闭"
          className="absolute inset-0 bg-black/40"
          onClick={requestClose}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="新令牌"
          className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-zinc-900">
                新令牌（仅显示一次）
              </h2>
              <p className={`${meta} mt-1`}>
                请立即复制并妥善保存；关闭后无法再次查看明文。
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭"
              className={`${linkBtn} text-[16px] leading-none`}
              onClick={requestClose}
            >
              ×
            </button>
          </div>

          <input
            id="issued-token-plaintext"
            className={`${input} mt-4 w-full font-mono text-[12px]`}
            readOnly
            value={token}
            onFocus={(event) => event.currentTarget.select()}
          />

          {copyFailed ? (
            <p className="mt-2 text-[12px] text-rose-600">
              自动复制失败，请手动选中上面的令牌复制后再关闭。
            </p>
          ) : null}

          <div className="mt-5 grid gap-2">
            <button type="button" className={`${btnBlue} w-full`} onClick={copyToken}>
              {copied ? "已复制" : "复制令牌"}
            </button>
            <button type="button" className={`${btnGhost} w-full`} onClick={requestClose}>
              确定
            </button>
          </div>
        </div>
      </div>

      {confirming ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="返回复制"
            className="absolute inset-0 bg-black/40"
            onClick={() => setConfirming(false)}
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="确认关闭"
            className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">确认关闭</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-600">
              您尚未复制新令牌，关闭后将无法再次查看明文，确定要关闭吗？
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={btnBlue} onClick={() => setConfirming(false)}>
                返回复制
              </button>
              <button
                type="button"
                className={`${btnGhost} text-rose-600`}
                onClick={onClose}
              >
                确认关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
