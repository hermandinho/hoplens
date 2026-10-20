// ESM entry. Re-exports the CJS build instead of shipping a second bundle, so a process that both
// imports and requires @hoplens/express (or preloads @hoplens/express/register) holds one runtime.
import cjs from "../dist/index.js";

export const hoplens = cjs.hoplens;
export default cjs.hoplens;
