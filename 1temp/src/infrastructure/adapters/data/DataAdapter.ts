import { Price, Amount, IV, FundingRate } from '@domain/value-objects';

export interface OHLCVData {
  timestamp: Date;
  open: Price;
  high: Price;
  low: Price;
  close: Price;
  volume: Amount;
}

export interface MarketDataPoint {
  timestamp: Date;
  price: Price;
  volume?: Amount;
  iv?: IV;
  fundingRate?: FundingRate;
  [key: string]: unknown;
}

export interface TradeEvent {
  timestamp: Date;
  price: Price;
  volume: Amount;
  type: 'swap' | 'simulated'; // Real swap or simulated from volume
}

export interface DataAdapter {
  fetchPrice(asset: string, timestamp: Date): Promise<Price>;
  fetchOHLCV(asset: string, startDate: Date, endDate: Date): Promise<OHLCVData[]>;
  fetchFundingRate(asset: string, timestamp: Date): Promise<FundingRate | null>;
  fetchIV(asset: string, timestamp: Date): Promise<IV | null>;
  fetchVolume(asset: string, timestamp: Date): Promise<Amount>;
  fetchTradeEvents?(asset: string, startDate: Date, endDate: Date): Promise<TradeEvent[]>; // Optional: fetch individual trade events
}

