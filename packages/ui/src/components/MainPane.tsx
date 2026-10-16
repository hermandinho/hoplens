import { builderOpen, closeBuilder, mainView } from "../state/store";
import { Details } from "./Details";
import { JourneyPane } from "./JourneyPane";
import { Overview } from "./Overview";
import { QueriesView } from "./QueriesView";
import { RequestBuilder } from "./RequestBuilder";
import { RequestsView } from "./RequestsView";
import { TraceHeader } from "./TraceHeader";

export function MainPane() {
  const view = mainView.value;
  if (view === "overview") {
    return (
      <main id="main" class="main" aria-label="Overview">
        <Overview />
      </main>
    );
  }
  if (view === "requests") {
    return (
      <main id="main" class="main main-requests" aria-label="Requests">
        <RequestsView />
      </main>
    );
  }
  if (view === "queries") {
    return (
      <main id="main" class="main" aria-label="Queries and hosts">
        <QueriesView />
      </main>
    );
  }
  return (
    <main id="main" class="main main-workbench" aria-label="Request, journey and details">
      {builderOpen.value && <BuilderDrawer />}
      <TraceHeader />
      <JourneyPane />
      <Details />
    </main>
  );
}

/** Collapsible request builder: opened from a route click or "New request", closed to give traces the room. */
function BuilderDrawer() {
  return (
    <section class="builder-drawer" aria-label="Request builder">
      <header class="builder-drawer-head">
        <span class="builder-drawer-title">New request</span>
        <button
          type="button"
          class="source-close"
          onClick={closeBuilder}
          aria-label="Close request builder"
          title="Close (the builder keeps your edits)"
        >
          ×
        </button>
      </header>
      <RequestBuilder />
    </section>
  );
}
