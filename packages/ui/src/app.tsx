import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ActionBar } from "./components/ActionBar";
import { Cheatsheet } from "./components/Cheatsheet";
import { MainPane } from "./components/MainPane";
import { MobileTabs } from "./components/Mobile";
import { Palette } from "./components/Palette";
import { SourcePeek } from "./components/SourcePeek";
import { TopBar } from "./components/TopBar";
import { selectHop, selectedHopId } from "./state/journey";
import { go, route } from "./state/router";
import { initShellKeys, onShellKeydown } from "./state/shellKeys";
import { bootstrap, initRouting, selectedTrace, startLive, stopLive } from "./state/store";

/**
 * `#/r/<trace>/s/<span>` <-> the span selected in the canvas. The hash selects the span once its
 * trace has loaded; picking another span rewrites the hash in place (no history entry per click).
 * Lives here, not in the store, because state/journey imports the store.
 */
function initSpanRouting(): () => void {
  const toHop = effect(() => {
    const r = route.value;
    const t = selectedTrace.value;
    if (r.view !== "trace" || !r.spanId || t?.id !== r.traceId) return;
    const span = r.spanId;
    // After this batch settles: a new trace first resets the span selection (state/journey).
    queueMicrotask(() => {
      const cur = route.peek();
      if (cur.view !== "trace" || cur.spanId !== span || selectedTrace.peek()?.id !== t.id) return;
      if (selectedHopId.peek() !== span && t.spans.some((s) => s.id === span)) selectHop(span);
    });
  });

  let traceSeen: string | null = null;
  let lastHop: string | null = null;
  const toHash = effect(() => {
    const hop = selectedHopId.value;
    const tid = selectedTrace.value?.id ?? null;
    const prev = lastHop;
    lastHop = hop;
    // A trace switch resets the hop to null; that reset must not strip a deep-linked span.
    if (tid !== traceSeen) {
      traceSeen = tid;
      return;
    }
    const r = route.peek();
    if (r.view !== "trace" || r.traceId !== tid || (r.spanId ?? null) === hop) return;
    if (hop) go({ ...r, spanId: hop }, { replace: true });
    else if (prev !== null && prev === r.spanId) {
      const { spanId: _drop, ...rest } = r;
      go(rest, { replace: true });
    }
  });
  return () => {
    toHop();
    toHash();
  };
}

export function App() {
  useEffect(() => {
    const disposeRouting = initRouting();
    const disposeSpans = initSpanRouting();
    // Every key goes through state/keymap (plan 3.9); state/shellKeys registers the shell's own.
    const disposeKeys = initShellKeys();
    void bootstrap();
    startLive();
    window.addEventListener("keydown", onShellKeydown);
    return () => {
      window.removeEventListener("keydown", onShellKeydown);
      disposeKeys();
      disposeSpans();
      disposeRouting();
      stopLive();
    };
  }, []);

  return (
    <div class="app">
      <a href="#main" class="skip-link">
        Skip to main content
      </a>
      <TopBar />
      <MainPane />
      <MobileTabs />
      <ActionBar />
      <SourcePeek />
      <Palette />
      <Cheatsheet />
    </div>
  );
}
