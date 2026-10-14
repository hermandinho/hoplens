import DefaultSchema from "@/lib/d/schemas";

export async function POST(req: Request) {
  const body = DefaultSchema.parse(await req.json());
  return Response.json(body);
}
