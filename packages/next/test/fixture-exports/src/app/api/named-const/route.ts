export const GET = () => Response.json([]);
export const PUT = async (req: Request) => Response.json(await req.json());
