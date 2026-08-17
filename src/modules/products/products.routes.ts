import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const productsRouter = Router();
productsRouter.use(requireModule("PRODUCTS"));

// Common units of measure for a hotel store. Kept as a fixed list (rather than
// free text) so stock reports don't end up with "kg"/"Kg"/"KGS" variants.
export const UNITS_OF_MEASURE = [
  "Each", "Pieces", "Kg", "Grams", "Litres", "Millilitres", "Box", "Carton",
  "Pack", "Dozen", "Roll", "Bottle", "Can", "Bag", "Set", "Pair", "Meter",
] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalNumber = (min = 0) => z.preprocess(blankToUndefined, z.coerce.number().min(min).optional());

const createSchema = z.object({
  storeId: z.string().trim().min(1),
  categoryId: optionalId,
  name: z.string().trim().min(1).max(150),
  sku: optionalText(60),
  barcode: optionalText(60),
  brand: optionalText(80),
  description: optionalText(500),
  photoUrl: optionalText(2000),
  unit: z.enum(UNITS_OF_MEASURE).default("Each"),
  isPerishable: z.boolean().default(false),
  shelfLifeDays: optionalNumber(0),
  quantity: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).default(0),
  maxStockLevel: optionalNumber(0),
  unitCost: optionalNumber(0),
  preferredSupplier: optionalText(120),
  isActive: z.boolean().default(true),
});
const updateSchema = createSchema.omit({ quantity: true }).partial();

const movementSchema = z.object({
  type: z.enum(["RECEIPT", "DISPATCH", "ADJUSTMENT"]),
  quantity: z.coerce.number().finite().refine((value) => value !== 0, "Quantity cannot be zero"),
  note: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
}).superRefine((value, context) => {
  if (["RECEIPT", "DISPATCH"].includes(value.type) && value.quantity < 0) {
    context.addIssue({ code: "custom", message: "Receipt and dispatch quantities must be positive", path: ["quantity"] });
  }
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const productFields = {
  id: true,
  storeId: true,
  store: { select: { id: true, name: true, code: true } },
  categoryId: true,
  category: { select: { id: true, name: true, level: true } },
  name: true,
  sku: true,
  barcode: true,
  brand: true,
  description: true,
  photoUrl: true,
  unit: true,
  isPerishable: true,
  shelfLifeDays: true,
  quantity: true,
  reorderLevel: true,
  maxStockLevel: true,
  unitCost: true,
  preferredSupplier: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

productsRouter.get("/", async (req, res) => {
  const query = z.object({
    search: z.string().trim().max(100).optional(),
    storeId: z.string().trim().optional(),
    categoryId: z.string().trim().optional(),
    lowStock: z.enum(["true", "false"]).optional(),
    active: z.enum(["true", "false"]).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid product filters", details: query.error.flatten() }); return; }
  const { search, storeId, categoryId, lowStock, active } = query.data;
  const tid = tenantId(req);
  const where: Prisma.ProductWhereInput = {
    tenantId: tid,
    ...(storeId ? { storeId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(active ? { isActive: active === "true" } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
      { barcode: { contains: search, mode: "insensitive" } },
      { brand: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const products = await prisma.product.findMany({ where, select: productFields, orderBy: { name: "asc" } });
  const visible = lowStock === "true" ? products.filter((p) => Number(p.quantity) <= Number(p.reorderLevel)) : products;
  const [total, active_, lowStockCount] = await Promise.all([
    prisma.product.count({ where: { tenantId: tid } }),
    prisma.product.count({ where: { tenantId: tid, isActive: true } }),
    prisma.product.findMany({ where: { tenantId: tid }, select: { quantity: true, reorderLevel: true } })
      .then((all) => all.filter((p) => Number(p.quantity) <= Number(p.reorderLevel)).length),
  ]);
  res.json({ products: visible, summary: { total, active: active_, inactive: total - active_, lowStock: lowStockCount } });
});

productsRouter.get("/:id", async (req, res) => {
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: productFields });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  res.json({ product });
});

productsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid product", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const { quantity, categoryId, ...rest } = data.data;
  try {
    const store = await prisma.store.findFirst({ where: { id: data.data.storeId, tenantId: tid, isActive: true } });
    if (!store) { res.status(400).json({ error: "Choose an active store from this property" }); return; }
    if (categoryId) {
      const category = await prisma.category.findFirst({ where: { id: categoryId, tenantId: tid } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({ data: { tenantId: tid, categoryId, quantity, ...rest }, select: productFields });
      if (quantity > 0) {
        await tx.inventoryMovement.create({
          data: { tenantId: tid, productId: created.id, storeId: created.storeId, type: "RECEIPT", quantity, note: "Opening stock", performedBy: req.userId },
        });
      }
      return created;
    });
    res.status(201).json({ product });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A product with this SKU or barcode already exists" }); return; }
    next(error);
  }
});

productsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid product", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.storeId) {
      const store = await prisma.store.findFirst({ where: { id: data.data.storeId, tenantId: tid, isActive: true } });
      if (!store) { res.status(400).json({ error: "Choose an active store from this property" }); return; }
    }
    if (data.data.categoryId) {
      const category = await prisma.category.findFirst({ where: { id: data.data.categoryId, tenantId: tid } });
      if (!category) { res.status(400).json({ error: "Selected category was not found" }); return; }
    }
    const updated = await prisma.product.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Product not found" }); return; }
    res.json({ product: await prisma.product.findUniqueOrThrow({ where: { id: req.params.id }, select: productFields }) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A product with this SKU or barcode already exists" }); return; }
    next(error);
  }
});

productsRouter.delete("/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.product.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
    if (!deleted.count) { res.status(404).json({ error: "Product not found" }); return; }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") { res.status(409).json({ error: "This product is used in a recipe and can't be deleted — deactivate it instead" }); return; }
    next(error);
  }
});

productsRouter.get("/:id/movements", async (req, res) => {
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  const movements = await prisma.inventoryMovement.findMany({
    where: { productId: product.id, tenantId: product.tenantId },
    include: { store: { select: { id: true, name: true } } },
    orderBy: { occurredAt: "desc" },
  });
  res.json({ product, movements });
});

productsRouter.post("/:id/movements", async (req, res) => {
  const data = movementSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid stock movement", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  const signedQuantity = data.data.type === "DISPATCH" ? -data.data.quantity : data.data.quantity;
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.product.updateMany({
      where: { id: product.id, quantity: { gte: signedQuantity < 0 ? Math.abs(signedQuantity) : 0 } },
      data: { quantity: { increment: signedQuantity } },
    });
    if (!updated.count) return null;
    return tx.inventoryMovement.create({
      data: { tenantId: tid, productId: product.id, storeId: product.storeId, type: data.data.type, quantity: signedQuantity, note: data.data.note, occurredAt: data.data.occurredAt, performedBy: req.userId },
    });
  });
  if (!result) { res.status(400).json({ error: "Dispatch would take stock below zero" }); return; }
  res.status(201).json({ movement: result, product: await prisma.product.findUniqueOrThrow({ where: { id: product.id }, select: productFields }) });
});
