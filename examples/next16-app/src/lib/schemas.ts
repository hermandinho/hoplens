import { z } from "zod";

export const CreateOrder = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(1).max(20),
  note: z.string().max(140).optional(),
  shipping: z.object({
    method: z.enum(["standard", "express"]),
    address: z.object({
      line1: z.string().min(3),
      city: z.string(),
      country: z.string().length(2),
    }),
  }),
  coupon: z.string().nullable().default(null),
});

export const ProductQuery = z.object({
  cat: z.enum(["shoes", "bags", "hats"]).default("shoes"),
  limit: z.coerce.number().int().positive().max(50).default(10),
});
