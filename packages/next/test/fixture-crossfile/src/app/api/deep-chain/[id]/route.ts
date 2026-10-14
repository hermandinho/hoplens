// Deep chain: route → c → b → a → defines Base.
import { RenamedBase as X } from "@/lib/c/schemas";

export async function PUT(req: Request) {
  const b = X.parse(await req.json());
  return Response.json(b);
}
