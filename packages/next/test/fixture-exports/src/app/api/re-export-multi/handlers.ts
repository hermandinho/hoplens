export function getHandler() { return Response.json([]); }
export async function postHandler(req: Request) { return Response.json(await req.json()); }
