-- CreateTable
CREATE TABLE "bot_state" (
    "poolId" TEXT NOT NULL,
    "priceLower" DOUBLE PRECISION NOT NULL,
    "priceUpper" DOUBLE PRECISION NOT NULL,
    "lastRebalancePrice" DOUBLE PRECISION NOT NULL,
    "lastRebalanceAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentVolatility" DOUBLE PRECISION,
    "currentHurst" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "bot_state_pkey" PRIMARY KEY ("poolId")
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "candles_poolAddress_timestamp_idx" ON "candles"("poolAddress", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "candles_poolAddress_timestamp_key" ON "candles"("poolAddress", "timestamp");
