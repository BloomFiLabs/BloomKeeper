/**
 * Rate Limit Simulation Test
 * 
 * Simulates the bot's scheduled tasks over a time period and calculates
 * whether we would exceed rate limits on Hyperliquid and Lighter.
 * 
 * Based on actual rate limits:
 * - Hyperliquid: 1200 weight/minute (https://hyperliquid.gitbook.io/hyperliquid-docs)
 * - Lighter: 24,000 weight/60s for premium (https://apidocs.lighter.xyz/docs/rate-limits)
 */

// ==================== RATE LIMIT CONFIGURATION ====================

const RATE_LIMITS = {
  HYPERLIQUID: {
    maxWeightPerMinute: 1200,
    safetyBuffer: 0.8, // Use 80% to be safe
    get effectiveLimit() { return this.maxWeightPerMinute * this.safetyBuffer; }
  },
  LIGHTER: {
    maxWeightPerMinute: 24000, // Premium account
    safetyBuffer: 0.8,
    get effectiveLimit() { return this.maxWeightPerMinute * this.safetyBuffer; }
  }
};

// API weights based on exchange documentation
const WEIGHTS = {
  HYPERLIQUID: {
    INFO_LIGHT: 2,      // l2Book, allMids, clearinghouseState, orderStatus
    INFO_HEAVY: 20,     // Most other info requests
    EXCHANGE: 1,        // Order placement (+ floor(batch/40))
    USER_ROLE: 60,
  },
  LIGHTER: {
    SEND_TX: 1,         // Order placement
    INFO: 1,            // Info requests
    CANCEL: 0,          // Cancels don't consume quota
  }
};

// ==================== SCHEDULED TASKS CONFIGURATION ====================

interface ScheduledTask {
  name: string;
  intervalMs: number;
  calls: {
    exchange: 'HYPERLIQUID' | 'LIGHTER' | 'BOTH';
    operation: string;
    weight: number;
    count: number; // Number of times this call is made per task execution
    usesWebSocket?: boolean; // If true, call is skipped (no REST needed)
  }[];
}

// Current scheduled tasks from PerpKeeperScheduler.ts
const SCHEDULED_TASKS: ScheduledTask[] = [
  {
    name: 'cancelOrdersForPairedPositions',
    intervalMs: 30000, // 30s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyRecentExecutionFills',
    intervalMs: 45000, // 45s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkPositionSizeBalance',
    intervalMs: 60000, // 60s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkProfitTaking',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'refreshCapitalMetrics',
    intervalMs: 60000, // 60s
    calls: [
      { exchange: 'BOTH', operation: 'getBalance', weight: 2, count: 1 },
    ]
  },
  {
    name: 'checkAndRetrySingleLegPositions',
    intervalMs: 90000, // 90s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyPositionStateWithExchanges',
    intervalMs: 90000, // 90s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 2 }, // refresh x2
    ]
  },
  {
    name: 'updatePerformanceMetricsPeriodically',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getFundingHistory', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'checkAndCloseUnprofitablePositions',
    intervalMs: 120000, // 120s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
    ]
  },
  {
    name: 'verifyTrackedOrders',
    intervalMs: 180000, // 180s
    calls: [
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'cleanupStaleOrders',
    intervalMs: 300000, // 300s
    calls: [
      { exchange: 'BOTH', operation: 'getOpenOrders', weight: 20, count: 1 },
    ]
  },
  {
    name: 'syncExchangeOrderHistory',
    intervalMs: 300000, // 300s
    calls: [
      { exchange: 'BOTH', operation: 'getOrderHistory', weight: 20, count: 2 },
    ]
  },
  {
    name: 'checkSpreadRotation',
    intervalMs: 600000, // 600s
    calls: [
      { exchange: 'BOTH', operation: 'getPositions', weight: 20, count: 1 },
      { exchange: 'BOTH', operation: 'getFundingRates', weight: 20, count: 1 },
    ]
  },
  {
    name: 'refreshMarketData',
    intervalMs: 900000, // 900s
    calls: [
      { exchange: 'BOTH', operation: 'getAllMarkets', weight: 20, count: 5 }, // Multiple markets
    ]
  },
];

// Simulated order activity (when actively trading)
const ORDER_ACTIVITY = {
  ordersPerHour: 20, // Estimated orders placed per hour
  cancelsPerHour: 10, // Estimated cancels per hour
  modifiesPerHour: 30, // Estimated order modifications per hour
};

// ==================== SIMULATION ENGINE ====================

interface SimulationResult {
  exchange: string;
  simulationMinutes: number;
  totalCalls: number;
  totalWeight: number;
  weightPerMinute: number;
  limit: number;
  utilizationPercent: number;
  wouldExceedLimit: boolean;
  peakMinuteWeight: number;
  taskBreakdown: { task: string; calls: number; weight: number }[];
  operationBreakdown: { operation: string; calls: number; weight: number }[];
}

function simulateRateLimits(
  durationMinutes: number = 60,
  useWebSocketCache: boolean = false,
  activeTrading: boolean = true
): { hyperliquid: SimulationResult; lighter: SimulationResult } {
  
  const durationMs = durationMinutes * 60 * 1000;
  
  // Track calls per exchange
  const hlCalls: { task: string; operation: string; weight: number; timestamp: number }[] = [];
  const lighterCalls: { task: string; operation: string; weight: number; timestamp: number }[] = [];
  
  // Simulate scheduled tasks
  for (const task of SCHEDULED_TASKS) {
    const executions = Math.floor(durationMs / task.intervalMs);
    
    for (let i = 0; i < executions; i++) {
      const timestamp = i * task.intervalMs;
      
      for (const call of task.calls) {
        // Skip if using WebSocket cache for positions/orders
        if (useWebSocketCache && 
            (call.operation === 'getPositions' || call.operation === 'getOpenOrders')) {
          // WebSocket cache hit - no REST call needed
          // But only for Lighter (we implemented WS for Lighter, not HL yet)
          if (call.exchange === 'LIGHTER') continue;
          if (call.exchange === 'BOTH') {
            // Only make call for Hyperliquid
            for (let c = 0; c < call.count; c++) {
              hlCalls.push({ task: task.name, operation: call.operation, weight: call.weight, timestamp });
            }
            continue;
          }
        }
        
        for (let c = 0; c < call.count; c++) {
          if (call.exchange === 'HYPERLIQUID' || call.exchange === 'BOTH') {
            hlCalls.push({ task: task.name, operation: call.operation, weight: call.weight, timestamp });
          }
          if (call.exchange === 'LIGHTER' || call.exchange === 'BOTH') {
            lighterCalls.push({ task: task.name, operation: call.operation, weight: call.weight, timestamp });
          }
        }
      }
    }
  }
  
  // Add order activity if actively trading
  if (activeTrading) {
    const ordersInPeriod = Math.floor((ORDER_ACTIVITY.ordersPerHour / 60) * durationMinutes);
    const cancelsInPeriod = Math.floor((ORDER_ACTIVITY.cancelsPerHour / 60) * durationMinutes);
    const modifiesInPeriod = Math.floor((ORDER_ACTIVITY.modifiesPerHour / 60) * durationMinutes);
    
    // Spread orders evenly across the time period
    for (let i = 0; i < ordersInPeriod; i++) {
      const timestamp = (i / ordersInPeriod) * durationMs;
      hlCalls.push({ task: 'orderPlacement', operation: 'placeOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
      lighterCalls.push({ task: 'orderPlacement', operation: 'placeOrder', weight: WEIGHTS.LIGHTER.SEND_TX, timestamp });
    }
    
    for (let i = 0; i < cancelsInPeriod; i++) {
      const timestamp = (i / cancelsInPeriod) * durationMs;
      hlCalls.push({ task: 'orderCancel', operation: 'cancelOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
      lighterCalls.push({ task: 'orderCancel', operation: 'cancelOrder', weight: WEIGHTS.LIGHTER.CANCEL, timestamp });
    }
    
    for (let i = 0; i < modifiesInPeriod; i++) {
      const timestamp = (i / modifiesInPeriod) * durationMs;
      hlCalls.push({ task: 'orderModify', operation: 'modifyOrder', weight: WEIGHTS.HYPERLIQUID.EXCHANGE, timestamp });
      lighterCalls.push({ task: 'orderModify', operation: 'modifyOrder', weight: WEIGHTS.LIGHTER.SEND_TX, timestamp });
    }
  }
  
  // Calculate per-minute weights to find peak
  const calculatePeakMinute = (calls: typeof hlCalls): number => {
    const minuteBuckets = new Map<number, number>();
    for (const call of calls) {
      const minute = Math.floor(call.timestamp / 60000);
      minuteBuckets.set(minute, (minuteBuckets.get(minute) || 0) + call.weight);
    }
    return Math.max(...Array.from(minuteBuckets.values()), 0);
  };
  
  // Build result for each exchange
  const buildResult = (
    exchange: string,
    calls: typeof hlCalls,
    limit: number
  ): SimulationResult => {
    const totalWeight = calls.reduce((sum, c) => sum + c.weight, 0);
    const weightPerMinute = totalWeight / durationMinutes;
    const peakMinuteWeight = calculatePeakMinute(calls);
    
    // Task breakdown
    const taskMap = new Map<string, { calls: number; weight: number }>();
    for (const call of calls) {
      const existing = taskMap.get(call.task) || { calls: 0, weight: 0 };
      existing.calls++;
      existing.weight += call.weight;
      taskMap.set(call.task, existing);
    }
    
    // Operation breakdown
    const opMap = new Map<string, { calls: number; weight: number }>();
    for (const call of calls) {
      const existing = opMap.get(call.operation) || { calls: 0, weight: 0 };
      existing.calls++;
      existing.weight += call.weight;
      opMap.set(call.operation, existing);
    }
    
    return {
      exchange,
      simulationMinutes: durationMinutes,
      totalCalls: calls.length,
      totalWeight,
      weightPerMinute: Math.round(weightPerMinute * 10) / 10,
      limit,
      utilizationPercent: Math.round((weightPerMinute / limit) * 1000) / 10,
      wouldExceedLimit: peakMinuteWeight > limit,
      peakMinuteWeight,
      taskBreakdown: Array.from(taskMap.entries())
        .map(([task, data]) => ({ task, ...data }))
        .sort((a, b) => b.weight - a.weight),
      operationBreakdown: Array.from(opMap.entries())
        .map(([operation, data]) => ({ operation, ...data }))
        .sort((a, b) => b.weight - a.weight),
    };
  };
  
  return {
    hyperliquid: buildResult('HYPERLIQUID', hlCalls, RATE_LIMITS.HYPERLIQUID.effectiveLimit),
    lighter: buildResult('LIGHTER', lighterCalls, RATE_LIMITS.LIGHTER.effectiveLimit),
  };
}

// ==================== TEST RUNNER ====================

function runSimulation() {
  console.log('='.repeat(80));
  console.log('RATE LIMIT SIMULATION TEST');
  console.log('='.repeat(80));
  console.log('\nSimulating 60 minutes of bot operation...\n');
  
  // Test 1: Without WebSocket caching (current behavior for Hyperliquid)
  console.log('📊 SCENARIO 1: Without WebSocket Position Cache');
  console.log('-'.repeat(60));
  const withoutWS = simulateRateLimits(60, false, true);
  printResult(withoutWS.hyperliquid);
  printResult(withoutWS.lighter);
  
  // Test 2: With WebSocket caching (new behavior for Lighter)
  console.log('\n📊 SCENARIO 2: With WebSocket Position Cache (Lighter only)');
  console.log('-'.repeat(60));
  const withWS = simulateRateLimits(60, true, true);
  printResult(withWS.hyperliquid);
  printResult(withWS.lighter);
  
  // Test 3: Heavy trading scenario
  console.log('\n📊 SCENARIO 3: Heavy Trading (2x order activity)');
  console.log('-'.repeat(60));
  ORDER_ACTIVITY.ordersPerHour = 40;
  ORDER_ACTIVITY.cancelsPerHour = 20;
  ORDER_ACTIVITY.modifiesPerHour = 60;
  const heavyTrading = simulateRateLimits(60, true, true);
  printResult(heavyTrading.hyperliquid);
  printResult(heavyTrading.lighter);
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY & RECOMMENDATIONS');
  console.log('='.repeat(80));
  
  console.log('\n🔴 HYPERLIQUID (Limit: 1200/min, Using: 960/min safe limit)');
  console.log(`   Current usage: ${withoutWS.hyperliquid.weightPerMinute}/min (${withoutWS.hyperliquid.utilizationPercent}%)`);
  console.log(`   Peak minute: ${withoutWS.hyperliquid.peakMinuteWeight}/min`);
  console.log(`   Status: ${withoutWS.hyperliquid.wouldExceedLimit ? '⚠️ MAY EXCEED LIMIT' : '✅ Within limits'}`);
  
  console.log('\n🟢 LIGHTER (Limit: 24000/min, Using: 19200/min safe limit)');
  console.log(`   Without WS cache: ${withoutWS.lighter.weightPerMinute}/min (${withoutWS.lighter.utilizationPercent}%)`);
  console.log(`   With WS cache: ${withWS.lighter.weightPerMinute}/min (${withWS.lighter.utilizationPercent}%)`);
  console.log(`   Improvement: ${Math.round((1 - withWS.lighter.weightPerMinute / withoutWS.lighter.weightPerMinute) * 100)}% reduction`);
  
  console.log('\n📋 TOP OPERATIONS BY WEIGHT:');
  console.log('\n   Hyperliquid:');
  withoutWS.hyperliquid.operationBreakdown.slice(0, 5).forEach(op => {
    console.log(`   - ${op.operation}: ${op.calls} calls, ${op.weight} weight (${Math.round(op.weight / withoutWS.hyperliquid.totalWeight * 100)}%)`);
  });
  
  console.log('\n   Lighter (without WS):');
  withoutWS.lighter.operationBreakdown.slice(0, 5).forEach(op => {
    console.log(`   - ${op.operation}: ${op.calls} calls, ${op.weight} weight (${Math.round(op.weight / withoutWS.lighter.totalWeight * 100)}%)`);
  });
  
  console.log('\n💡 RECOMMENDATIONS:');
  if (withoutWS.hyperliquid.utilizationPercent > 50) {
    console.log('   1. Add WebSocket position subscription for Hyperliquid (like we did for Lighter)');
    console.log('   2. Increase intervals for non-critical tasks');
    console.log('   3. Consolidate multiple getPositions() calls into shared cache');
  }
  if (withoutWS.lighter.utilizationPercent > 10) {
    console.log('   4. Lighter WS cache should reduce REST calls significantly');
  }
  
  // Return results for programmatic use
  return { withoutWS, withWS, heavyTrading };
}

function printResult(result: SimulationResult) {
  const status = result.wouldExceedLimit ? '🔴' : result.utilizationPercent > 50 ? '🟡' : '🟢';
  
  console.log(`\n${status} ${result.exchange}`);
  console.log(`   Total calls: ${result.totalCalls} over ${result.simulationMinutes} minutes`);
  console.log(`   Total weight: ${result.totalWeight}`);
  console.log(`   Average: ${result.weightPerMinute}/min (limit: ${result.limit}/min)`);
  console.log(`   Utilization: ${result.utilizationPercent}%`);
  console.log(`   Peak minute: ${result.peakMinuteWeight}/min`);
  console.log(`   Would exceed limit: ${result.wouldExceedLimit ? 'YES ⚠️' : 'No ✅'}`);
  
  console.log(`   Top tasks by weight:`);
  result.taskBreakdown.slice(0, 3).forEach(t => {
    console.log(`     - ${t.task}: ${t.calls} calls, ${t.weight} weight`);
  });
}

// Run the simulation
const results = runSimulation();

// Export for Jest if needed
export { simulateRateLimits, SCHEDULED_TASKS, RATE_LIMITS, WEIGHTS, runSimulation };

