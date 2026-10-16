import { UpstreamError, getPokemon } from "@/lib/external";
import { PokemonQuery } from "@/lib/schemas";
import { type NextRequest, NextResponse } from "next/server";

// Next fetch cache vs no-store: the default uses `next: { revalidate: 60 }` so repeat hits are
// served from the data cache; ?cache=0 forces a fresh ~300KB upstream fetch every time.
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const parsed = PokemonQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ issues: parsed.error.issues }, { status: 422 });
  }
  try {
    const pokemon = await getPokemon(name, parsed.data.cache === "1");
    return NextResponse.json({ cached: parsed.data.cache === "1", pokemon });
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) {
      return NextResponse.json({ error: `No pokemon named "${name}"` }, { status: 404 });
    }
    throw err;
  }
}
