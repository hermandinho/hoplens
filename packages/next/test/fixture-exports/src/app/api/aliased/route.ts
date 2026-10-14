async function del(req: Request) { return Response.json(await req.json()); }
export { del as DELETE };
