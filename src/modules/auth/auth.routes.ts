import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifySecret } from "../../lib/hash.js";

export const authRouter = Router();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1),
});

const userFields = { id: true, firstName: true, lastName: true, email: true, role: true } as const;

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

function bearerToken(req: { header(name: string): string | undefined }): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

authRouter.post("/login", async (req, res, next) => {
  const data = loginSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Enter a valid email and password" }); return; }
  try {
    const user = await prisma.user.findFirst({ where: { tenantId: tenantId(req), email: data.data.email } });
    if (!user || !user.isActive || !verifySecret(data.data.password, user.password)) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { token, userId: user.id, tenantId: tenantId(req), expiresAt } });
    res.json({
      token,
      expiresAt,
      user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role },
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (req, res) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }
  const session = await prisma.session.findUnique({ where: { token }, include: { user: { select: userFields } } });
  if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "Session expired" }); return; }
  res.json({ user: session.user, tenantId: session.tenantId, expiresAt: session.expiresAt });
});

authRouter.post("/logout", async (req, res) => {
  const token = bearerToken(req);
  if (token) await prisma.session.deleteMany({ where: { token } });
  res.status(204).send();
});
