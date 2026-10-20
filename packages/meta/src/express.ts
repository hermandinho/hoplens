// `import { hoplens } from "hoplens/express"`: the Express adapter, re-exported so users do not
// need @hoplens/express as a separate direct dep (pnpm does not hoist it).
export { hoplens, default } from "@hoplens/express";
export type { HoplensOptions, HoplensProfile } from "@hoplens/express";
