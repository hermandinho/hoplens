import { RenamedBase } from "@/lib/c/schemas";

export async function POST(req: Request) {
  const data = await req.json();
  const parsed = RenamedBase.parse(data);
  return Response.json(parsed);
}
