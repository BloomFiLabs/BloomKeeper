-- CreateTable
CREATE TABLE "trade_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "longExchange" TEXT NOT NULL,
    "shortExchange" TEXT NOT NULL,
    "longFundingRate" REAL NOT NULL,
    "shortFundingRate" REAL NOT NULL,
    "spread" REAL NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expectedReturnUsd" REAL,
    "actualReturnUsd" REAL,
    "positionValueUsd" REAL,
    "executionTimeMs" INTEGER
);

-- CreateTable
CREATE TABLE "bot_state" (
    "poolId" TEXT NOT NULL PRIMARY KEY,
    "priceLower" REAL NOT NULL,
    "priceUpper" REAL NOT NULL,
    "lastRebalancePrice" REAL NOT NULL,
    "lastRebalanceAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentVolatility" REAL,
    "currentHurst" REAL,
    "isActive" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolAddress" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "trade_decisions_timestamp_idx" ON "trade_decisions"("timestamp");

-- CreateIndex
CREATE INDEX "trade_decisions_symbol_idx" ON "trade_decisions"("symbol");

-- CreateIndex
CREATE INDEX "candles_poolAddress_timestamp_idx" ON "candles"("poolAddress", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "candles_poolAddress_timestamp_key" ON "candles"("poolAddress", "timestamp");
