type Tone = "ok" | "warn" | "bad";

const toneRing: Record<Tone, string> = {
  ok: "border-emerald-300",
  warn: "border-amber-300",
  bad: "border-rose-300",
};

const toneValue: Record<Tone, string> = {
  ok: "text-zinc-900",
  warn: "text-amber-600",
  bad: "text-rose-600",
};

interface StatTileProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
}

/** 统计条单格：label / 数值 / 阈值提示，tone 只影响描边与数值色 */
export function StatTile({ label, value, hint, tone }: StatTileProps) {
  return (
    <div
      className={`rounded-2xl border-[3px] bg-white p-3 shadow-card ${tone ? toneRing[tone] : "border-zinc-200"}`}
    >
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tracking-tight ${tone ? toneValue[tone] : "text-zinc-900"}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}
