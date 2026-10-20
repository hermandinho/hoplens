export async function register() {
  // Hoplens: request journey visualizer at /__hoplens (dev only)
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
    await import("hoplens/node");
  }
}
