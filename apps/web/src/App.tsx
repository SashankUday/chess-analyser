import { useEffect, useState } from "react";
import { sessionToken } from "./api";
import { Header } from "./components/Header";
import { GamePage } from "./pages/GamePage";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { socket } from "./socket";
import { useApp } from "./store";

type Route = { page: "home" } | { page: "settings" } | { page: "game"; gameId: string; ply: number | null };

function parseRoute(hash: string): Route {
  const m = /^#\/game\/([0-9a-f-]{36})(?:\?ply=(\d+))?/.exec(hash);
  if (m) return { page: "game", gameId: m[1]!, ply: m[2] ? Number(m[2]) : null };
  if (hash.startsWith("#/settings")) return { page: "settings" };
  return { page: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const off = socket.on((e) => useApp.getState().handleEvent(e));
    socket.connect();
    void useApp.getState().loadSettings().catch(() => undefined);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (route.page !== "game") socket.send({ type: "ui.state", gameId: null, ply: null });
  }, [route.page]);

  if (!sessionToken()) {
    return (
      <div className="page">
        <div className="banner banner-error">
          This page was opened without a ChessAnalyser session. Start the app with <code>npm run dev</code> and use the
          address it prints.
        </div>
      </div>
    );
  }

  return (
    <>
      <Header />
      <main>
        {route.page === "home" && <HomePage />}
        {route.page === "settings" && <SettingsPage />}
        {route.page === "game" && <GamePage key={route.gameId} gameId={route.gameId} initialPly={route.ply} />}
      </main>
    </>
  );
}
