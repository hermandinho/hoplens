import { z } from "zod";

export const Address = z.object({ city: z.string(), country: z.string().length(2) });
export const Base = z.object({ email: z.email(), age: z.number().int().min(18).max(120).optional() });
export const CreateUser = Base.extend({
  role: z.enum(["admin", "member"]).default("member"),
  address: Address,
  tags: z.array(z.string().min(2)).min(1),
  agreed: z.literal(true),
});
