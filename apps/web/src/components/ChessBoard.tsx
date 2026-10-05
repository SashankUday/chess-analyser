// The only component that knows about the underlying board library (spec §37). Swapping it out
// should not affect application state. Legality comes from chess-core, never from the board.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import { legalMoves } from "@chessanalyser/chess-core";
import type { MoveClassification, OverlayRole } from "@chessanalyser/shared";
import { ClassificationBadge } from "@chessanalyser/ui";

export interface BoardArrow {
  from: string;
  to: string;
  role: OverlayRole | "engine";
}

export interface ChessBoardProps {
  fen: string;
  orientation: "white" | "black";
  lastMove?: string | null;
  checkSquare?: string | null;
  arrows?: BoardArrow[];
  highlights?: { square: string; role: OverlayRole }[];
  badge?: { square: string; classification: MoveClassification } | null;
  onMove?: (uci: string) => void;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#4e7aa5";
}

/** Resolved colours for SVG arrows (CSS variables cannot be used in SVG attributes). */
function useRoleColours(): Record<BoardArrow["role"], string> {
  const [palette, setPalette] = useState(document.documentElement.dataset.palette);
  useEffect(() => {
    const obs = new MutationObserver(() => setPalette(document.documentElement.dataset.palette));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette"] });
    return () => obs.disconnect();
  }, []);
  return useMemo(
    () => ({
      engine: cssVar("--selection"),
      primary: cssVar("--selection"),
      warning: cssVar("--role-warning"),
      danger: cssVar("--role-danger"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [palette],
  );
}

const ROLE_FILL: Record<OverlayRole, string> = {
  primary: "color-mix(in srgb, var(--selection) 55%, transparent)",
  warning: "color-mix(in srgb, var(--role-warning) 55%, transparent)",
  danger: "color-mix(in srgb, var(--role-danger) 55%, transparent)",
};

export function ChessBoard(props: ChessBoardProps) {
  const { fen, orientation, lastMove, checkSquare, arrows = [], highlights = [], badge, onMove } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const colours = useRoleColours();

  useEffect(() => setSelected(null), [fen]);

  const moves = useMemo(() => {
    try {
      return legalMoves(fen);
    } catch {
      return [];
    }
  }, [fen]);
  const targets = useMemo(() => (selected ? moves.filter((m) => m.from === selected) : []), [moves, selected]);

  const tryMove = (from: string, to: string): boolean => {
    const candidates = moves.filter((m) => m.from === from && m.to === to);
    if (!candidates.length || !onMove) return false;
    const chosen = candidates.find((m) => !m.promotion || m.promotion === "q") ?? candidates[0]!;
    onMove(chosen.lan);
    setSelected(null);
    return true;
  };

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    const add = (sq: string, s: CSSProperties) => (styles[sq] = { ...styles[sq], ...s });
    if (lastMove) {
      const tint = { backgroundColor: "color-mix(in srgb, var(--selection) 42%, transparent)" };
      add(lastMove.slice(0, 2), tint);
      add(lastMove.slice(2, 4), tint);
    }
    for (const h of highlights) add(h.square, { boxShadow: `inset 0 0 0 100vmax ${ROLE_FILL[h.role]}` });
    if (checkSquare) {
      add(checkSquare, { background: "radial-gradient(circle, rgb(220 40 40 / 0.85) 0%, rgb(220 40 40 / 0.35) 45%, transparent 72%)" });
    }
    if (selected) add(selected, { backgroundColor: "color-mix(in srgb, var(--selection) 60%, transparent)" });
    for (const t of targets) {
      add(t.to, {
        backgroundImage: t.captured
          ? "radial-gradient(circle, transparent 58%, rgb(0 0 0 / 0.22) 60%)"
          : "radial-gradient(circle, rgb(0 0 0 / 0.2) 18%, transparent 20%)",
        cursor: "pointer",
      });
    }
    return styles;
  }, [lastMove, highlights, checkSquare, selected, targets]);

  const boardArrows = useMemo(
    () => arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: colours[a.role] })),
    [arrows, colours],
  );

  return (
    <Chessboard
      options={{
        id: "chessanalyser-board",
        position: fen,
        boardOrientation: orientation,
        darkSquareStyle: { backgroundColor: "var(--board-dark)" },
        lightSquareStyle: { backgroundColor: "var(--board-light)" },
        darkSquareNotationStyle: { color: "var(--board-light)", fontWeight: 600 },
        lightSquareNotationStyle: { color: "var(--board-dark)", fontWeight: 600 },
        squareStyles,
        arrows: boardArrows,
        animationDurationInMs: 160,
        allowDragging: !!onMove,
        clearArrowsOnPositionChange: true,
        onPieceDrop: ({ sourceSquare, targetSquare }) => (targetSquare ? tryMove(sourceSquare, targetSquare) : false),
        onSquareClick: ({ square }) => {
          if (selected && tryMove(selected, square)) return;
          setSelected(moves.some((m) => m.from === square) && square !== selected ? square : null);
        },
        squareRenderer: ({ square, children }) => (
          <div style={{ position: "relative", width: "100%", height: "100%" }}>
            {children}
            {badge?.square === square && (
              <div className="square-badge">
                <ClassificationBadge classification={badge.classification} />
              </div>
            )}
          </div>
        ),
      }}
    />
  );
}
