import { z } from "zod";

const Subscribe = z.object({
  email: z.string().email(),
  topics: z.array(z.enum(["releases", "security", "events"])).min(1),
  consent: z.literal(true),
});

export async function POST(req: Request) {
  const parsed = Subscribe.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ issues: parsed.error.issues }, { status: 422 });
  }
  return Response.json({ ok: true, email: parsed.data.email }, { status: 201 });
}
