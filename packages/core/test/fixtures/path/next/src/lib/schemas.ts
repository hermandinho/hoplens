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

// Query schemas for the public-API demo routes. Hoplens reads these to prefill the request builder.
const Flag = z.enum(["0", "1"]).default("0");

export const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(10),
  fast: Flag,
});

export const DashboardQuery = z.object({
  city: z.string().min(2).max(60).default("Montreal"),
  currency: z.string().length(3).toUpperCase().default("EUR"),
  parallel: Flag,
});

export const CatalogQuery = z.object({
  category: z.string().min(2).default("smartphones"),
  limit: z.coerce.number().int().min(1).max(30).default(8),
  currency: z.string().length(3).toUpperCase().default("EUR"),
});

export const PokemonQuery = z.object({
  cache: z.enum(["0", "1"]).default("1"),
});

export const ReportQuery = z.object({
  big: Flag,
  rounds: z.coerce.number().int().min(1).max(200).default(60),
});

export const FlakyQuery = z.object({
  mode: z.enum(["ok", "fail", "timeout", "random"]).default("random"),
});

// Query schemas for the database demo routes (/api/db/*).
export const DbProductsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(40).default(12),
  fast: Flag,
});

export const DbSearchQuery = z.object({
  q: z.string().trim().min(2).max(40).default("battery"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
