import { z } from "zod";

const DefaultSchema = z.object({
  tag: z.string(),
  qty: z.number().int().min(1),
});

export default DefaultSchema;
