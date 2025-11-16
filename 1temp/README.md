# Bloom Backtesting Framework

DDD Hexagonal Architecture Backtesting Framework for Bloom Vault Strategies

## Quick Start

```bash
# Install dependencies
npm install

# Run tests and main backtest
npm start

# Or run tests only
npm test

# Or run backtest only (skips tests)
npm run backtest
```

## Project Structure

```
src/
├── domain/           # Domain layer (entities, value objects, services)
├── application/      # Application layer (use cases)
├── infrastructure/   # Infrastructure layer (adapters)
└── shared/          # Shared utilities and configs
```

## Testing

All tests are in the `tests/` directory. Run with:

```bash
npm test              # Run tests once
npm run test:watch    # Watch mode
npm run test:ui       # UI mode
npm run test:coverage # Coverage report
```

## Main Commands

- `npm start` - Run tests then execute main backtest
- `npm test` - Run test suite
- `npm run build` - Build TypeScript
- `npm run backtest` - Run backtest only (skips tests)
- `npm run lint` - Lint code
- `npm run format` - Format code

## Configuration

Set environment variables:

```bash
THE_GRAPH_API_KEY=your_api_key_here
```

## Strategies Tested

The main backtest (`npm start`) tests:

1. **Volatile Pair Strategy** (ETH/USDC)
   - Range: ±5%
   - Allocation: 40%
   - Uses real APR from The Graph

2. **Options Overlay Strategy** (ETH/USDC)
   - Range: ±3%
   - Allocation: 30%
   - Uses real APR from The Graph

## Results

Results are saved to `./results/main-backtest.json` after each run.

## Example Scripts

Additional example scripts are in `examples/` directory, but the primary entry point is `npm start`.
