import type { NextFunction, Request, Response } from "express";
import { hasPermission } from "./tenantContext.js";
import { resolveShiftFor, isWithinShift } from "../lib/shifts.js";

/**
 * Blocks a request outside the acting employee's current shift window —
 * checked on every tenant request (not just at login), so an already-open
 * session stops working the moment a shift ends. SHIFT_EXEMPT (or Super
 * Admin, who bypasses every permission) skips this entirely; an employee
 * with no rotation configured is unrestricted. Mounted after the /auth
 * routes so login/me/logout are never blocked by it — login has its own
 * explicit check before a session is even issued.
 */
export function enforceShiftAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.tenantId || !req.userId) { next(); return; }
  const { tenantId, userId } = req;
  hasPermission(tenantId, userId, "SHIFT_EXEMPT")
    .then(async (exempt) => {
      if (exempt) { next(); return; }
      const shift = await resolveShiftFor(tenantId, userId);
      if (!shift || isWithinShift(shift)) { next(); return; }
      res.status(403).json({
        error: `Outside your shift hours (${shift.name}, ${shift.startTime}–${shift.endTime}). Access is restricted to your scheduled shift.`,
        code: "OUTSIDE_SHIFT",
      });
    })
    .catch(next);
}
