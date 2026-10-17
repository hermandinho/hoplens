import { Router } from "express";

export const files = Router();

const FAKE_TREE = {
  "": ["docs", "images", "readme.txt"],
  docs: ["guide.md", "api.md"],
  images: ["logo.svg", "banner.png"],
};

/**
 * SEEDED CASE (wildcard): Express 5 named wildcard. `/files/docs/guide.md` gives
 * `req.params.splat = ["docs", "guide.md"]`; Hoplens groups every such request under one route,
 * `/files/:splat+`.
 */
files.get("/*splat", (req, res) => {
  const parts = req.params.splat;
  const dir = parts.join("/");
  const entries = FAKE_TREE[dir];
  if (entries) {
    res.json({ path: dir, type: "dir", entries });
    return;
  }
  const parent = parts.slice(0, -1).join("/");
  const name = parts[parts.length - 1];
  if (FAKE_TREE[parent]?.includes(name)) {
    res.json({ path: dir, type: "file", size: 1024 + name.length * 37 });
    return;
  }
  res.status(404).json({ error: "no such file", path: dir });
});
