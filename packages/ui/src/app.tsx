import { useEffect } from "preact/hooks";
import { Inspector } from "./components/Inspector";
import { MainPane } from "./components/MainPane";
import { Sidebar } from "./components/Sidebar";
import { SourcePeek } from "./components/SourcePeek";
import { StatusBanner } from "./components/StatusBanner";
import { TopBar } from "./components/TopBar";
import { focusQueryBar, logVisible, moveCursor, openCursor } from "./state/requestLog";
import { bootstrap, initHashRouting, sidebarTab, startLive, stopLive } from "./state/store";

/**
 * Global keys for the request log: `/` focuses the query bar, j/k (and Up/Down on a row) move the
 * cursor, Enter opens it. Ignored while typing and with modifiers, so nothing shadows the browser.
 */
function onGlobalKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (e.key === "/") {
    e.preventDefault();
    focusQueryBar();
    return;
  }
  if (!logVisible(sidebarTab.value === "traffic")) return;
  const onRow = !!el?.closest?.("[data-trace-id]");
  // Up/Down only on a log row: the journey canvas and other widgets own the arrows elsewhere.
  const down = e.key === "j" || (onRow && e.key === "ArrowDown");
  const up = e.key === "k" || (onRow && e.key === "ArrowUp");
  if (down || up) {
    e.preventDefault();
    moveCursor(down ? 1 : -1);
  } else if (e.key === "Enter" && !el?.closest?.("button, a, [role=tab], summary")) {
    if (openCursor()) e.preventDefault();
  }
}

export function App() {
  useEffect(() => {
    void bootstrap();
    startLive();
    const disposeHash = initHashRouting();
    window.addEventListener("keydown", onGlobalKey);
    return () => {
      window.removeEventListener("keydown", onGlobalKey);
      disposeHash();
      stopLive();
    };
  }, []);

  return (
    <div class="app">
      <a href="#main" class="skip-link">
        Skip to main content
      </a>
      <StatusBanner />
      <TopBar />
      <Sidebar />
      <MainPane />
      <Inspector />
      <SourcePeek />
    </div>
  );
}
