import { Router } from "express";
import fs from "node:fs";
import path from "node:path";

// Public, unauthenticated downloads — currently just the HOTELIER print
// bridge installer. No tenant, no auth: this is a device install, not tenant
// data, so it's mounted standalone before tenantContext (same pattern as
// public-receipts). The binary itself isn't in git (~90MB, rebuilt
// independently of app releases) — it's dropped straight onto the VPS at
// RELEASE_DIR by whoever publishes a new bridge version.
export const downloadsRouter = Router();

const RELEASE_DIR = path.resolve(process.cwd(), "releases", "print-bridge");

downloadsRouter.get("/print-bridge", (_req, res) => {
  const file = path.join(RELEASE_DIR, "hotelier-print-bridge.exe");
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "The print bridge hasn't been published yet." });
    return;
  }
  res.download(file, "hotelier-print-bridge.exe");
});
