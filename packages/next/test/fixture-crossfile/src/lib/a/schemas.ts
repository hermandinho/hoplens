import { z } from "zod";

export const Base = z.object({
  email: z.email(),
  age: z.number().int().min(18).optional(),
});
