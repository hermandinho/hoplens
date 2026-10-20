import type { Route } from "./router";

/**
 * The header pieces the Requests subject draws (MainPane's RequestSubject + BuilderDrawer, and the
 * request header's own "New request" button).
 *
 * The builder drawer always carries its "New request" label (for the route picker). There is one
 * close at a time, and it stays in view while the user scrolls (on phones it is the pinned "< Back"):
 *   - with only the builder open (no request or compare under it) there is no subject bar at all:
 *     the drawer's close is the one, and the drawer head is pinned (sticky) so it stays reachable;
 *   - over a request or a compare, the sticky subject bar keeps its close, but while the builder is
 *     open that close closes the builder (the topmost layer first, as Esc does: shellKeys
 *     escapeStep, the drawer, then the subject) and the drawer draws none;
 *   - the request header's "New request" button steps aside while the builder is open, so the
 *     label is not shown twice.
 */
export interface SubjectChrome {
  /** Draw the subject bar (label, nav, close). */
  bar: boolean;
  /** The bar's label. */
  kind: "Request" | "Compare";
  /** What the bar's close closes; null: no close on the bar. */
  barClose: "subject" | "builder" | null;
  /** Draw a close in the builder drawer's head. */
  drawerClose: boolean;
  /** Pin (sticky) the builder drawer's head: it carries the only close. */
  drawerHeadPinned: boolean;
  /** Draw the request header's "New request" button. */
  traceNewRequest: boolean;
}

export function subjectChrome(view: Route["view"], builderOpen: boolean): SubjectChrome {
  const isTrace = view === "trace";
  const bar = isTrace || view === "compare";
  const drawerClose = builderOpen && !bar;
  return {
    bar,
    kind: isTrace ? "Request" : "Compare",
    barClose: bar ? (builderOpen ? "builder" : "subject") : null,
    drawerClose,
    drawerHeadPinned: drawerClose,
    traceNewRequest: !builderOpen,
  };
}
