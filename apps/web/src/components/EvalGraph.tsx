import { useMemo } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  CLASSIFICATION_LABELS,
  EVAL_GRAPH_CAP_PAWNS,
  formatEvaluation,
  graphValue,
  moveNumberLabel,
  type GameMove,
  type MoveReview,
  type PositionEvaluation,
} from "@chessanalyser/shared";

interface Point {
  ply: number;
  value: number | null;
  label: string;
  evalText: string;
  review: MoveReview | null;
}

const MARKED = new Set(["blunder", "mistake", "brilliant"]);

/** White-centric evaluation across the game (spec §8). Click a point to jump to that position. */
export function EvalGraph({
  positions,
  moves,
  reviews,
  currentPly,
  onSelect,
}: {
  positions: (PositionEvaluation | null)[];
  moves: GameMove[];
  reviews: MoveReview[];
  currentPly: number | null;
  onSelect: (ply: number) => void;
}) {
  const data: Point[] = useMemo(() => {
    const byPly = new Map(reviews.map((r) => [r.ply, r]));
    return positions.map((p, ply) => ({
      ply,
      value: p ? graphValue(p.evaluation) : null,
      label: ply === 0 ? "Start" : `${moveNumberLabel(ply)} ${moves[ply - 1]?.san ?? ""}`,
      evalText: p ? formatEvaluation(p.evaluation) : "…",
      review: byPly.get(ply) ?? null,
    }));
  }, [positions, moves, reviews]);

  if (!positions.some(Boolean)) {
    return <div className="graph-empty muted">Analyse the game to see the evaluation graph.</div>;
  }

  const cap = EVAL_GRAPH_CAP_PAWNS;
  return (
    <div
      style={{ width: "100%", height: 150, background: "var(--eval-black)", borderRadius: 6, overflow: "hidden", cursor: "pointer" }}
      aria-label="Evaluation graph"
      // Map the click position to a ply directly (works for taps without a prior hover).
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const fraction = (e.clientX - rect.left) / rect.width;
        onSelect(Math.max(0, Math.min(data.length - 1, Math.round(fraction * (data.length - 1)))));
      }}
    >
      <ResponsiveContainer>
        <AreaChart
          data={data}
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        >
          <XAxis dataKey="ply" hide />
          <YAxis domain={[-cap, cap]} hide allowDataOverflow />
          <Area
            type="monotone"
            dataKey="value"
            baseValue={-cap}
            stroke="var(--colour-primary)"
            strokeWidth={2}
            fill="var(--eval-white)"
            fillOpacity={1}
            connectNulls
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number }) => {
              const p = data[props.index ?? 0];
              if (!p?.review || !MARKED.has(p.review.classification) || props.cx === undefined || props.cy === undefined) {
                return <g key={props.index} />;
              }
              return (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={4.5}
                  fill={`var(--q-${p.review.classification})`}
                  stroke="var(--surface-raised)"
                  strokeWidth={2}
                />
              );
            }}
            activeDot={{ r: 5, stroke: "var(--surface-raised)", strokeWidth: 2, fill: "var(--colour-primary)" }}
          />
          <ReferenceLine y={0} stroke="var(--text-muted)" strokeOpacity={0.35} strokeDasharray="3 3" />
          {currentPly !== null && <ReferenceLine x={currentPly} stroke="var(--selection)" strokeWidth={2} />}
          <Tooltip content={GraphTooltip} cursor={{ stroke: "var(--text-muted)", strokeWidth: 1 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function GraphTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload as Point;
  return (
    <div className="card" style={{ padding: "6px 10px", fontSize: 12 }}>
      <div style={{ fontWeight: 650 }}>{p.label}</div>
      <div style={{ fontFamily: "var(--font-mono)" }}>{p.evalText}</div>
      {p.review && <div className={`qc-${p.review.classification}`}>{CLASSIFICATION_LABELS[p.review.classification]}</div>}
    </div>
  );
}
