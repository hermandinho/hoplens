import { NextRequest } from "next/server";
import * as S from "@/lib";
import { CreateUser } from "@/lib";

const Query = z.object({ expand: z.coerce.boolean().default(false) });

export async function GET(req: NextRequest) {
  const q = Query.parse(Object.fromEntries(req.nextUrl.searchParams));
  return Response.json(q);
}

export const PUT = async (request: Request) => {
  const data = await request.json();
  const parsed = CreateUser.safeParse(data);
  return Response.json(parsed);
};

async function remove(req: Request) {
  const b = S.Base.parse(await req.json());
  return Response.json(b);
}
export { remove as DELETE };
