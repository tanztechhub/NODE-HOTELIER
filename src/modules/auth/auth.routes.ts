import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { verifySecret } from "../../lib/hash.js";

export const authRouter = Router();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  employeeCode: z.string().trim().min(1),
  pin: z.string().trim().min(1),
});

const roleSelect = { select: { id: true, name: true, allowedSections: true } } as const;

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

function bearerToken(req: { header(name: string): string | undefined }): string | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function publicEmployee(employee: {
  id: string; firstName: string; lastName: string; employeeCode: string; jobTitle: string;
  department: string; role: { id: string; name: string; allowedSections: string[] } | null;
}) {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    employeeCode: employee.employeeCode,
    jobTitle: employee.jobTitle,
    department: employee.department,
    role: employee.role,
  };
}

authRouter.post("/login", async (req, res, next) => {
  const data = loginSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Enter your employee code and PIN" }); return; }
  try {
    const employee = await prisma.employee.findFirst({
      where: { tenantId: tenantId(req), employeeCode: { equals: data.data.employeeCode, mode: "insensitive" } },
      include: { role: roleSelect },
    });
    if (!employee || employee.status !== "ACTIVE" || !verifySecret(data.data.pin, employee.pin)) {
      res.status(401).json({ error: "Incorrect employee code or PIN" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await prisma.session.create({ data: { token, employeeId: employee.id, tenantId: tenantId(req), expiresAt } });
    res.json({ token, expiresAt, user: publicEmployee(employee) });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (req, res) => {
  const token = bearerToken(req);
  if (!token) { res.status(401).json({ error: "Not authenticated" }); return; }
  const session = await prisma.session.findUnique({ where: { token }, include: { employee: { include: { role: roleSelect } } } });
  if (!session || session.expiresAt < new Date()) { res.status(401).json({ error: "Session expired" }); return; }
  res.json({ user: publicEmployee(session.employee), tenantId: session.tenantId, expiresAt: session.expiresAt });
});

authRouter.post("/logout", async (req, res) => {
  const token = bearerToken(req);
  if (token) await prisma.session.deleteMany({ where: { token } });
  res.status(204).send();
});
