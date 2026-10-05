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
  const [promotion, setPromotion] = useState<{ from: string; to: string; colour: "w" | "b" } | null>(null);
  const colours = useRoleColours();

  useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [fen]);

  useEffect(() => {
    if (!promotion) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPromotion(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [promotion]);

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
    setSelected(null);
    if (candidates.some((m) => m.promotion)) {
      // Underpromotion is supported: ask instead of assuming a queen (V2 plan §43).
      setPromotion({ from, to, colour: candidates[0]!.color });
      return false;
    }
    onMove(candidates[0]!.lan);
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
    <div style={{ position: "relative" }}>
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
      {promotion && (
        <div className="promotion-overlay" onClick={() => setPromotion(null)}>
          <div className="card promotion-menu" role="dialog" aria-label="Choose promotion piece" onClick={(e) => e.stopPropagation()}>
            {(["q", "r", "b", "n"] as const).map((p, i) => (
              <button
                key={p}
                autoFocus={i === 0}
                aria-label={PROMOTION_NAMES[p]}
                title={PROMOTION_NAMES[p]}
                data-testid={`promote-${p}`}
                onClick={() => {
                  onMove?.(`${promotion.from}${promotion.to}${p}`);
                  setPromotion(null);
                }}
              >
                {(promotion.colour === "w" ? WHITE_GLYPHS : BLACK_GLYPHS)[p]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const PROMOTION_NAMES = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" } as const;
const WHITE_GLYPHS = { q: "♕", r: "♖", b: "♗", n: "♘" } as const;
const BLACK_GLYPHS = { q: "♛", r: "♜", b: "♝", n: "♞" } as const;
