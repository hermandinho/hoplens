import { bootstrap, hasRoutes, liveStatus, loadError, loadStatus, metaState } from "../state/store";

/**
 * Prominent full-width banner that only shows when something's actively wrong or important:
 * - bootstrap failed with no cached data → red "can't reach Hoplens"
 * - SSE in reconnecting state → amber "reconnecting"
 * - OTel not attached → amber informational
 * - config not wrapped with withHoplens → amber informational
 * Dismissed implicitly: when things come right, the banner just goes away.
 */
export function StatusBanner() {
  const err = loadError.value;
  const status = loadStatus.value;
  const live = liveStatus.value;
  const meta = metaState.value;

  if (err && !hasRoutes.value && status === "error") {
    return (
      <div class="banner banner-err" role="alert">
        <div class="banner-body">
          <b>Can't reach Hoplens.</b> {err}
          <div class="banner-hint">
            Is <code>next dev</code> running? Is <code>@hoplens/next/node</code> imported from{" "}
            <code>instrumentation.ts</code>?
          </div>
        </div>
        <button type="button" class="banner-action" onClick={() => void bootstrap()}>
          Retry
        </button>
      </div>
    );
  }

  if (live === "reconnecting") {
    return (
      <output class="banner banner-warn">
        <div class="banner-body">
          <b>Live stream disconnected.</b> Reconnecting with backoff. Traces that arrive during the gap will show up
          when the stream resumes.
        </div>
      </output>
    );
  }

  if (meta && meta.otel === "none") {
    return (
      <output class="banner banner-warn">
        <div class="banner-body">
          <b>OpenTelemetry provider missing.</b> Framework hops (router, handler, fetch) will not show up. Install{" "}
          <code>@vercel/otel</code> or let Hoplens register its own by removing any manual OTel setup from{" "}
          <code>instrumentation.ts</code>.
        </div>
      </output>
    );
  }

  if (meta && meta.configured === false) {
    return (
      <output class="banner banner-warn">
        <div class="banner-body">
          <b>next.config isn't wrapped with withHoplens.</b> Route scanning works, but function hops and schema pre-fill
          are off. Run <code>npx hoplens init</code> to wire it up.
        </div>
      </output>
    );
  }

  return null;
}
