// Side-effect entry: `await import("hoplens/node")` from instrumentation
// boots the Hoplens runtime. Re-exports @hoplens/next/node so users don't
// need to add that scoped package as a separate direct dep.
import "@hoplens/next/node";
