import { useEffect } from "preact/hooks";
import { Inspector } from "./components/Inspector";
import { MainPane } from "./components/MainPane";
import { Sidebar } from "./components/Sidebar";
import { SourcePeek } from "./components/SourcePeek";
import { TopBar } from "./components/TopBar";
import { bootstrap, startLive, stopLive } from "./state/store";

export function App() {
  useEffect(() => {
    void bootstrap();
    startLive();
    return () => stopLive();
  }, []);

  return (
    <div class="app">
      <a href="#main" class="skip-link">
        Skip to request builder
      </a>
      <TopBar />
      <Sidebar />
      <MainPane />
      <Inspector />
      <SourcePeek />
    </div>
  );
}
