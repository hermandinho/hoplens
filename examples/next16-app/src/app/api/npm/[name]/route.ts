export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { cache: "no-store" });
  if (!res.ok) return Response.json({ error: `npm returned ${res.status}` }, { status: 502 });
  const pkg = await res.json();
  return Response.json({ name: pkg.name, version: pkg.version, description: pkg.description });
}
