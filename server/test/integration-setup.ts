/**
 * Integration test setup
 * 
 * Loads environment variables and configures test timeouts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load testnet environment first, then fallback to regular .env
dotenv.config({ path: path.resolve(__dirname, '../.env.testnet') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Increase Jest timeout for integration tests (network calls take time)
jest.setTimeout(60000);

// Suppress console.debug in tests unless DEBUG is set
if (!process.env.DEBUG) {
  console.debug = () => {};
}

// Log test environment
console.log('\n=== Integration Test Environment ===');
console.log(`Hyperliquid Testnet: ${process.env.HYPERLIQUID_TESTNET === 'true' ? 'YES' : 'NO'}`);
console.log(`Extended Testnet: ${process.env.EXTENDED_TESTNET === 'true' ? 'YES' : 'NO'}`);
console.log(`Lighter configured: ${process.env.LIGHTER_API_KEY ? 'YES' : 'NO'}`);
console.log(`Aster configured: ${process.env.ASTER_API_KEY ? 'YES' : 'NO'}`);
console.log('=====================================\n');

