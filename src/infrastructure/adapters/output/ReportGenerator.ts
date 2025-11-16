import { stringify } from 'csv-stringify/sync';
import { BacktestResult } from '@domain/services/BacktestEngine';
import * as fs from 'fs';
import * as path from 'path';

export class ReportGenerator {
  generateCSV(result: BacktestResult, filePath: string): void {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && dir !== '..') {
      fs.mkdirSync(dir, { recursive: true });
    }

    const rows: Array<Record<string, unknown>> = [];

    // Portfolio summary
    rows.push({
      Metric: 'Total Return',
      Value: `${result.metrics.totalReturn.toFixed(2)}%`,
    });
    rows.push({
      Metric: 'Sharpe Ratio',
      Value: result.metrics.sharpeRatio.toFixed(4),
    });
    rows.push({
      Metric: 'Max Drawdown',
      Value: `${result.metrics.maxDrawdown.toFixed(2)}%`,
    });
    rows.push({
      Metric: 'Final Value',
      Value: result.metrics.finalValue.toFixed(2),
    });

    // Trades
    rows.push({ Metric: '', Value: '' });
    rows.push({ Metric: 'Trades', Value: '' });
    rows.push({
      Metric: 'ID',
      Value: 'Strategy',
      Value2: 'Asset',
      Value3: 'Side',
      Value4: 'Amount',
      Value5: 'Price',
    });

    for (const trade of result.trades) {
      rows.push({
        Metric: trade.id,
        Value: trade.strategyId,
        Value2: trade.asset,
        Value3: trade.side,
        Value4: trade.amount.value,
        Value5: trade.price.value,
      });
    }

    const csv = stringify(rows, { header: true });
    fs.writeFileSync(filePath, csv);
  }

  generateJSON(result: BacktestResult, filePath: string): void {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && dir !== '..') {
      fs.mkdirSync(dir, { recursive: true });
    }

    const report = {
      metrics: result.metrics,
      trades: result.trades.map((t) => ({
        id: t.id,
        strategyId: t.strategyId,
        asset: t.asset,
        side: t.side,
        amount: t.amount.value,
        price: t.price.value,
        timestamp: t.timestamp.toISOString(),
      })),
      positions: result.positions.map((p) => ({
        id: p.id,
        strategyId: p.strategyId,
        asset: p.asset,
        amount: p.amount.value,
        entryPrice: p.entryPrice.value,
        currentPrice: p.currentPrice.value,
      })),
      historicalValues: result.historicalValues,
      historicalReturns: result.historicalReturns,
    };

    fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  }
}

