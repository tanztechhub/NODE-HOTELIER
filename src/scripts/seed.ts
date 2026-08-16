import { prisma } from "../lib/prisma.js";
import { hashSecret } from "../lib/hash.js";

const oneYearFromNow = new Date();
oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);

const licenseFields = {
  licenseStatus: "TRIAL",
  subscriptionPlan: "Hotelier Standard — Yearly",
  maxBranches: 3,
  maxUsers: 10,
  maxDevices: 10,
  nextDueDate: oneYearFromNow,
} as const;

const tenant = await prisma.tenant.upsert({
  where: { slug: "hotelier-demo" },
  update: { ...licenseFields },
  create: { name: "HOTELIER Demo", slug: "hotelier-demo", ...licenseFields },
});

await prisma.user.upsert({
  where: { tenantId_email: { tenantId: tenant.id, email: "admin@hotelier-demo.co.ke" } },
  update: {},
  create: {
    tenantId: tenant.id,
    email: "admin@hotelier-demo.co.ke",
    password: hashSecret("Admin@123"),
    firstName: "Evans",
    lastName: "Nyongesa",
    role: "SUPER_ADMIN",
    isActive: true,
  },
});

for (const moduleKey of ["PRODUCTS", "STORE", "POS", "KITCHEN", "ROOMS", "RESERVATIONS", "HOUSEKEEPING", "HR"] as const) {
  await prisma.module.upsert({
    where: { key: moduleKey },
    update: {},
    create: { key: moduleKey, name: moduleKey.replace("_", " ") },
  });
  await prisma.tenantModule.upsert({
    where: { tenantId_moduleKey: { tenantId: tenant.id, moduleKey } },
    update: { isEnabled: true },
    create: { tenantId: tenant.id, moduleKey, isEnabled: true },
  });
}

const ALL_SECTIONS = ["OVERVIEW", "RECEPTION", "HOUSEKEEPING", "SALES", "KITCHEN", "SERVICE_CENTER", "INVENTORY", "TEAM", "FINANCE", "REPORTS", "SYSTEM"] as const;

for (const role of [
  { name: "Super Admin", description: "Full access to every section of the workspace.", allowedSections: ALL_SECTIONS },
  { name: "Manager", description: "Oversees daily operations across the property.", allowedSections: ALL_SECTIONS },
  { name: "Receptionist", description: "Front desk check-in, reservations, and guest billing.", allowedSections: ["OVERVIEW", "RECEPTION"] },
  { name: "Chef", description: "Kitchen orders, menu, and recipes.", allowedSections: ["OVERVIEW", "KITCHEN"] },
  { name: "Waiter", description: "Point of sale, tables, and orders.", allowedSections: ["OVERVIEW", "SALES"] },
  { name: "Housekeeping", description: "Room tasks and cleanliness tracking.", allowedSections: ["OVERVIEW", "HOUSEKEEPING"] },
  { name: "Storekeeper", description: "Inventory, stock, and supplier records.", allowedSections: ["OVERVIEW", "INVENTORY"] },
  { name: "Accountant", description: "Finance, expenses, and reports.", allowedSections: ["OVERVIEW", "FINANCE", "REPORTS"] },
] as const) {
  await prisma.role.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: role.name } },
    update: { description: role.description, allowedSections: [...role.allowedSections], isSystemRole: true },
    create: { tenantId: tenant.id, name: role.name, description: role.description, allowedSections: [...role.allowedSections], isSystemRole: true },
  });
}

for (const store of [
  { name: "Main Store", code: "MAIN" },
  { name: "Bakery Store", code: "BAKERY" },
]) {
  await prisma.store.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: store.code } },
    update: { name: store.name, isActive: true },
    create: { tenantId: tenant.id, ...store },
  });
}

await prisma.cafeSettings.upsert({
  where: { tenantId: tenant.id },
  update: {},
  create: { tenantId: tenant.id, cafeName: "TANZ Café", currency: "KES" },
});

for (const roomType of [
  { name: "Standard Single", description: "Comfortable room for one guest", capacity: 1, baseRate: 4500, amenities: ["Wi-Fi", "Desk", "Shower"] },
  { name: "Standard Double", description: "Practical double room for couples or solo travellers", capacity: 2, baseRate: 5500, amenities: ["Wi-Fi", "Double bed", "Shower", "Desk"] },
  { name: "Standard Twin", description: "Two separate beds for two guests", capacity: 2, baseRate: 6200, amenities: ["Wi-Fi", "Twin beds", "Shower"] },
  { name: "Superior Queen", description: "Upgraded room with a queen-size bed", capacity: 2, baseRate: 7200, amenities: ["Wi-Fi", "Queen bed", "Smart TV", "Tea station"] },
  { name: "Deluxe King", description: "Spacious room with a king-size bed", capacity: 2, baseRate: 8500, amenities: ["Wi-Fi", "King bed", "Mini fridge", "Smart TV"] },
  { name: "Triple Room", description: "Flexible room configured for three guests", capacity: 3, baseRate: 9500, amenities: ["Wi-Fi", "Three beds", "Smart TV", "Mini fridge"] },
  { name: "Junior Suite", description: "Open-plan suite with a comfortable sitting area", capacity: 2, baseRate: 11500, amenities: ["Wi-Fi", "King bed", "Sitting area", "Mini bar"] },
  { name: "Executive Suite", description: "Premium suite with a separate living area", capacity: 3, baseRate: 14500, amenities: ["Wi-Fi", "King bed", "Living room", "Mini bar"] },
  { name: "Family Room", description: "Flexible accommodation for families", capacity: 5, baseRate: 12000, amenities: ["Wi-Fi", "Multiple beds", "Smart TV", "Mini fridge"] },
  { name: "Connecting Rooms", description: "Two connected rooms for families or groups", capacity: 6, baseRate: 18000, amenities: ["Wi-Fi", "Connecting door", "Multiple beds", "Two bathrooms"] },
  { name: "Accessible Room", description: "Step-free room with accessible bathroom fittings", capacity: 2, baseRate: 7000, amenities: ["Wi-Fi", "Step-free access", "Grab rails", "Roll-in shower"] },
  { name: "Honeymoon Suite", description: "Romantic premium suite for special stays", capacity: 2, baseRate: 20000, amenities: ["King bed", "Bathtub", "Lounge", "Welcome package"] },
  { name: "Presidential Suite", description: "Signature luxury suite for VIP stays", capacity: 4, baseRate: 30000, amenities: ["Butler service", "Dining area", "Lounge", "Premium mini bar"] },
  { name: "Penthouse Suite", description: "Top-floor luxury suite with expansive living space", capacity: 6, baseRate: 45000, amenities: ["Private terrace", "Dining room", "Kitchenette", "Butler service"] },
]) {
  await prisma.roomType.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: roomType.name } }, update: {}, create: { tenantId: tenant.id, ...roomType } });
}

for (const room of [
  { number: "102", name: "Garden Single", type: "Standard Single", capacity: 1, nightlyRate: 4500 },
  { number: "103", name: "Courtyard Double", type: "Standard Double", capacity: 2, nightlyRate: 5500 },
  { number: "104", name: "Classic Twin", type: "Standard Twin", capacity: 2, nightlyRate: 6200 },
  { number: "105", name: "Queen Comfort", type: "Superior Queen", capacity: 2, nightlyRate: 7200 },
  { number: "201", name: "Deluxe King", type: "Deluxe King", capacity: 2, nightlyRate: 8500 },
  { number: "202", name: "Group Triple", type: "Triple Room", capacity: 3, nightlyRate: 9500 },
  { number: "203", name: "Junior Retreat", type: "Junior Suite", capacity: 2, nightlyRate: 11500 },
  { number: "204", name: "Executive Residence", type: "Executive Suite", capacity: 3, nightlyRate: 14500 },
  { number: "205", name: "Family Haven", type: "Family Room", capacity: 5, nightlyRate: 12000 },
  { number: "301", name: "Family Connector", type: "Connecting Rooms", capacity: 6, nightlyRate: 18000 },
  { number: "302", name: "Accessible Comfort", type: "Accessible Room", capacity: 2, nightlyRate: 7000 },
  { number: "303", name: "Honeymoon Retreat", type: "Honeymoon Suite", capacity: 2, nightlyRate: 20000 },
  { number: "401", name: "Presidential Residence", type: "Presidential Suite", capacity: 4, nightlyRate: 30000 },
  { number: "501", name: "Sky Penthouse", type: "Penthouse Suite", capacity: 6, nightlyRate: 45000 },
]) {
  await prisma.room.upsert({
    where: { tenantId_number: { tenantId: tenant.id, number: room.number } },
    update: {},
    create: { tenantId: tenant.id, ...room, status: "VACANT", cleanliness: "CLEAN" },
  });
}

const menu = [
  { category: "Hot drinks", name: "Espresso", description: "Single espresso shot", price: 250, temperature: "HOT" },
  { category: "Hot drinks", name: "Americano", description: "Espresso with hot water", price: 300, temperature: "HOT" },
  { category: "Hot drinks", name: "Cappuccino", description: "Espresso, steamed milk and foam", price: 400, temperature: "HOT" },
  { category: "Hot drinks", name: "Caffè Latte", description: "Espresso with silky steamed milk", price: 450, temperature: "HOT" },
  { category: "Hot drinks", name: "Masala Tea", description: "Spiced black tea with milk", price: 250, temperature: "HOT" },
  { category: "Cold drinks", name: "Iced Latte", description: "Espresso, milk and ice", price: 500, temperature: "COLD" },
  { category: "Cold drinks", name: "Cold Brew", description: "Slow-steeped chilled coffee", price: 450, temperature: "COLD" },
  { category: "Cold drinks", name: "Fresh Lemonade", description: "Fresh lemon, water and ice", price: 350, temperature: "COLD" },
  { category: "Cold drinks", name: "Mango Smoothie", description: "Mango, yoghurt and ice", price: 550, temperature: "COLD" },
  { category: "Bakery", name: "Butter Croissant", description: "Flaky all-butter pastry", price: 250, temperature: "OTHER" },
  { category: "Bakery", name: "Blueberry Muffin", description: "Soft muffin with blueberries", price: 300, temperature: "OTHER" },
  { category: "Bakery", name: "Chocolate Cake Slice", description: "Dark chocolate cake with ganache", price: 400, temperature: "OTHER" },
] as const;

for (const [sortOrder, categoryName] of ["Hot drinks", "Cold drinks", "Bakery"].entries()) {
  await prisma.menuCategory.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: categoryName } },
    update: { sortOrder },
    create: { tenantId: tenant.id, name: categoryName, sortOrder },
  });
}

for (const entry of menu) {
  const category = await prisma.menuCategory.findUniqueOrThrow({
    where: { tenantId_name: { tenantId: tenant.id, name: entry.category } },
  });
  const existing = await prisma.menuItem.findFirst({ where: { tenantId: tenant.id, name: entry.name } });
  const data = { categoryId: category.id, description: entry.description, price: entry.price, temperature: entry.temperature, isAvailable: true };
  if (existing) await prisma.menuItem.update({ where: { id: existing.id }, data });
  else await prisma.menuItem.create({ data: { tenantId: tenant.id, name: entry.name, ...data } });
}

for (const addon of [
  { name: "Extra espresso shot", price: 75 },
  { name: "Oat milk", price: 60 },
  { name: "Vanilla syrup", price: 40 },
  { name: "Whipped cream", price: 35 },
]) {
  await prisma.addon.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: addon.name } },
    update: { price: addon.price, isActive: true },
    create: { tenantId: tenant.id, ...addon },
  });
}

console.log(`Seed complete. Add this to REACT/.env: VITE_TENANT_ID=${tenant.id}`);
await prisma.$disconnect();
