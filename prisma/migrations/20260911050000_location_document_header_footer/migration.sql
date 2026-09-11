-- Per-location free-text blocks for receipts/invoices/quotations.
ALTER TABLE "Location" ADD COLUMN     "invoiceFooter" TEXT,
ADD COLUMN     "invoiceHeader" TEXT,
ADD COLUMN     "quotationFooter" TEXT,
ADD COLUMN     "quotationHeader" TEXT,
ADD COLUMN     "receiptFooter" TEXT,
ADD COLUMN     "receiptHeader" TEXT;
