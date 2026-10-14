import { c, warn } from "../style";

/** Unwire Hoplens from the current project — reverse of `init`. */
export async function remove(_args: string[]) {
  console.log(`\n${c.magenta("◆ Hoplens")} remove\n`);
  warn("remove is not implemented yet — delete the withHoplens(...) wrapper and the @hoplens/next/node import by hand, then `npm rm hoplens`.");
}
