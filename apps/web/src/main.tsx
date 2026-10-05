import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Apply the last palette immediately to avoid a flash before settings load.
try {
  document.documentElement.dataset.palette = localStorage.getItem("chessanalyser.palette") ?? "navy";
} catch {
  document.documentElement.dataset.palette = "navy";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
