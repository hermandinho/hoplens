export async function fetchAndFilter(_url: string, filters: { status?: number; tag?: string } = {}, limit = 25) {
  const items: Array<{ id: string; status: number }> = [];
  return items.filter((x) => (filters.status ? x.status === filters.status : true)).slice(0, limit);
}
