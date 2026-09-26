-- CreateTable
CREATE TABLE "Operation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "selectionMode" TEXT NOT NULL,
    "filters" TEXT,
    "resolveCursor" TEXT,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "userLabel" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',
    "revertOf" TEXT,
    "revertedAt" DATETIME,
    "revertedBy" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "leaseUntil" DATETIME
);

-- CreateTable
CREATE TABLE "OperationTarget" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "operationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "expect" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "pendingBefore" TEXT,
    "result" TEXT,
    CONSTRAINT "OperationTarget_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShopConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "settings" TEXT NOT NULL,
    "decisions" TEXT NOT NULL,
    "latestDryRunId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DryRunItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "data" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "LocalValueCache" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Operation_shop_createdAt_idx" ON "Operation"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_status_leaseUntil_idx" ON "Operation"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "OperationTarget_operationId_state_seq_idx" ON "OperationTarget"("operationId", "state", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "OperationTarget_operationId_productId_key" ON "OperationTarget"("operationId", "productId");

-- CreateIndex
CREATE INDEX "DryRunItem_shop_operationId_idx" ON "DryRunItem"("shop", "operationId");

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
