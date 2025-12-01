import { Injectable, Logger } from '@nestjs/common';
import { IBotStateRepository } from '../../domain/ports/IBotStateRepository';
import { IStrategyExecutor } from '../../domain/ports/IStrategyExecutor';
import { ethers } from 'ethers';

export interface PerformanceMetrics {
  totalDeposited: number;
  currentNAV: number;
  totalFeesEarned: number;
  totalFeesCollected: number; // Actual fees harvested from Uniswap
  totalGasCosts: number;
  netProfit: number;
  roi: number;
  dailyAPY: number;
  annualizedAPY: number;
  rebalanceCount: number;
  harvestCount: number; // Number of fee collections
  lastRebalanceTime?: Date;
  lastHarvestTime?: Date;
  lastHarvestAmount?: number;
  timeSinceStart: number; // hours
  averageRebalanceCost: number;
  feesPerDay: number;
  feesPerHarvest: number;
}

@Injectable()
export class PerformanceTracker {
  private readonly logger = new Logger(PerformanceTracker.name);
  private metrics: Map<string, PerformanceMetrics> = new Map();
  
  // Track initial deployment
  private deploymentTime: Date = new Date();
  private initialNAV: Map<string, number> = new Map();
  private rebalanceCosts: Map<string, number[]> = new Map();
  private harvestAmounts: Map<string, number[]> = new Map();
  private harvestTimes: Map<string, Date[]> = new Map();

  constructor() {}

  async trackPerformance(
    strategyAddress: string,
    currentNAV: number,
    feesEarned: number = 0,
    gasCost: number = 0,
  ): Promise<PerformanceMetrics> {
    // Initialize if first time
    if (!this.initialNAV.has(strategyAddress)) {
      this.initialNAV.set(strategyAddress, currentNAV);
      this.rebalanceCosts.set(strategyAddress, []);
      this.harvestAmounts.set(strategyAddress, []);
      this.harvestTimes.set(strategyAddress, []);
    }

    const initial = this.initialNAV.get(strategyAddress) || currentNAV;
    const costs = this.rebalanceCosts.get(strategyAddress) || [];
    const harvests = this.harvestAmounts.get(strategyAddress) || [];
    const harvestTimesList = this.harvestTimes.get(strategyAddress) || [];
    
    // Add gas cost if provided
    if (gasCost > 0) {
      costs.push(gasCost);
      this.rebalanceCosts.set(strategyAddress, costs);
    }

    const totalGasCosts = costs.reduce((sum, cost) => sum + cost, 0);
    const totalFeesCollected = harvests.reduce((sum, amount) => sum + amount, 0);
    const netProfit = (currentNAV - initial) + feesEarned - totalGasCosts;
    const roi = initial > 0 ? (netProfit / initial) * 100 : 0;
    
    // Calculate time metrics
    const now = new Date();
    const hoursSinceStart = (now.getTime() - this.deploymentTime.getTime()) / (1000 * 60 * 60);
    const daysSinceStart = hoursSinceStart / 24;
    
    // Calculate APY
    const dailyAPY = daysSinceStart > 0 ? (netProfit / initial) / daysSinceStart * 100 : 0;
    const annualizedAPY = dailyAPY * 365;
    
    // Fees per day
    const feesPerDay = daysSinceStart > 0 ? totalFeesCollected / daysSinceStart : 0;
    
    // Average rebalance cost
    const averageRebalanceCost = costs.length > 0 ? totalGasCosts / costs.length : 0;
    
    // Fees per harvest
    const feesPerHarvest = harvests.length > 0 ? totalFeesCollected / harvests.length : 0;
    
    // Last harvest info
    const lastHarvestAmount = harvests.length > 0 ? harvests[harvests.length - 1] : undefined;
    const lastHarvestTime = harvestTimesList.length > 0 ? harvestTimesList[harvestTimesList.length - 1] : undefined;

    const metrics: PerformanceMetrics = {
      totalDeposited: initial,
      currentNAV,
      totalFeesEarned: feesEarned,
      totalFeesCollected,
      totalGasCosts,
      netProfit,
      roi,
      dailyAPY,
      annualizedAPY,
      rebalanceCount: costs.length,
      harvestCount: harvests.length,
      lastHarvestTime,
      lastHarvestAmount,
      timeSinceStart: hoursSinceStart,
      averageRebalanceCost,
      feesPerDay,
      feesPerHarvest,
    };

    this.metrics.set(strategyAddress, metrics);
    return metrics;
  }

  getMetrics(strategyAddress: string): PerformanceMetrics | undefined {
    return this.metrics.get(strategyAddress);
  }

  logPerformance(strategyName: string, metrics: PerformanceMetrics) {
    this.logger.log('');
    this.logger.log('═══════════════════════════════════════════════════════════');
    this.logger.log(`📊 PERFORMANCE METRICS: ${strategyName}`);
    this.logger.log('═══════════════════════════════════════════════════════════');
    this.logger.log(`💰 Initial Deposit:        $${metrics.totalDeposited.toFixed(2)}`);
    this.logger.log(`📈 Current NAV:            $${metrics.currentNAV.toFixed(2)}`);
    this.logger.log(`✨ Total Fees Earned:      $${metrics.totalFeesEarned.toFixed(4)}`);
    this.logger.log(`💵 Fees Collected:         $${metrics.totalFeesCollected.toFixed(4)} (${metrics.harvestCount} harvests)`);
    this.logger.log(`⛽ Total Gas Costs:        $${metrics.totalGasCosts.toFixed(4)}`);
    this.logger.log(`💵 Net Profit:             $${metrics.netProfit.toFixed(4)} (${metrics.roi.toFixed(2)}% ROI)`);
    this.logger.log('───────────────────────────────────────────────────────────');
    this.logger.log(`📊 Daily APY:              ${metrics.dailyAPY.toFixed(2)}%`);
    this.logger.log(`📊 Annualized APY:         ${metrics.annualizedAPY.toFixed(2)}%`);
    this.logger.log(`📅 Fees Per Day:           $${metrics.feesPerDay.toFixed(4)}`);
    this.logger.log(`💰 Avg Per Harvest:        $${metrics.feesPerHarvest.toFixed(4)}`);
    if (metrics.lastHarvestTime && metrics.lastHarvestAmount !== undefined) {
      const minutesAgo = Math.floor((Date.now() - metrics.lastHarvestTime.getTime()) / 60000);
      this.logger.log(`🕐 Last Harvest:           $${metrics.lastHarvestAmount.toFixed(4)} (${minutesAgo} min ago)`);
    }
    this.logger.log('───────────────────────────────────────────────────────────');
    this.logger.log(`🔄 Rebalance Count:        ${metrics.rebalanceCount}`);
    this.logger.log(`💰 Harvest Count:          ${metrics.harvestCount}`);
    this.logger.log(`⚡ Avg Rebalance Cost:     $${metrics.averageRebalanceCost.toFixed(4)}`);
    this.logger.log(`⏱️  Time Running:           ${metrics.timeSinceStart.toFixed(2)} hours`);
    this.logger.log('═══════════════════════════════════════════════════════════');
    this.logger.log('');
  }

  logCompactMetrics(strategyName: string, metrics: PerformanceMetrics) {
    this.logger.log(
      `💰 ${strategyName} | NAV: $${metrics.currentNAV.toFixed(2)} | ` +
      `P&L: $${metrics.netProfit.toFixed(4)} (${metrics.roi.toFixed(2)}%) | ` +
      `APY: ${metrics.annualizedAPY.toFixed(1)}% | ` +
      `Harvests: ${metrics.harvestCount} ($${metrics.totalFeesCollected.toFixed(4)}) | ` +
      `Rebalances: ${metrics.rebalanceCount}`
    );
  }

  recordRebalance(strategyAddress: string, gasCostUSD: number) {
    const costs = this.rebalanceCosts.get(strategyAddress) || [];
    costs.push(gasCostUSD);
    this.rebalanceCosts.set(strategyAddress, costs);
    
    this.logger.log(`🔄 Rebalance #${costs.length} completed | Gas: $${gasCostUSD.toFixed(4)}`);
  }

  recordHarvest(strategyAddress: string, feesCollectedUSD: number) {
    const harvests = this.harvestAmounts.get(strategyAddress) || [];
    const times = this.harvestTimes.get(strategyAddress) || [];
    
    harvests.push(feesCollectedUSD);
    times.push(new Date());
    
    this.harvestAmounts.set(strategyAddress, harvests);
    this.harvestTimes.set(strategyAddress, times);
    
    const total = harvests.reduce((sum, amount) => sum + amount, 0);
    this.logger.log(`💰 Harvest #${harvests.length} completed | Fees: $${feesCollectedUSD.toFixed(4)} | Total: $${total.toFixed(4)}`);
  }

  setDeploymentTime(time: Date) {
    this.deploymentTime = time;
  }
}

