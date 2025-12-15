/**
 * Swap ETH to USDC on Arbitrum via Uniswap V3
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const WETH_ADDRESS = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const UNISWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'; // Uniswap V3 SwapRouter

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           SWAP ETH → USDC ON ARBITRUM');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  console.log(`Wallet: ${wallet.address}`);

  // Check ETH balance
  const ethBalance = await provider.getBalance(wallet.address);
  console.log(`ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);

  // Swap amount (keep some for gas)
  const swapAmount = ethBalance - ethers.parseEther('0.001'); // Keep 0.001 ETH for gas
  
  if (swapAmount <= 0n) {
    console.log('❌ Insufficient ETH balance');
    return;
  }

  console.log(`Swapping: ${ethers.formatEther(swapAmount)} ETH`);

  // Get USDC balance before
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdcBefore = await usdc.balanceOf(wallet.address);
  console.log(`USDC Before: ${Number(usdcBefore) / 1e6} USDC`);

  // Setup router
  const router = new ethers.Contract(UNISWAP_ROUTER, ROUTER_ABI, wallet);

  // Swap parameters
  const params = {
    tokenIn: WETH_ADDRESS,
    tokenOut: USDC_ADDRESS,
    fee: 500, // 0.05% fee tier (best for stables/ETH)
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600, // 10 minutes
    amountIn: swapAmount,
    amountOutMinimum: 0, // Accept any amount (for testing - use proper slippage in prod)
    sqrtPriceLimitX96: 0,
  };

  console.log('\nExecuting swap...');

  try {
    const tx = await router.exactInputSingle(params, {
      value: swapAmount,
      gasLimit: 300000,
    });

    console.log(`TX Hash: ${tx.hash}`);
    console.log('Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

    // Check USDC balance after
    const usdcAfter = await usdc.balanceOf(wallet.address);
    const usdcReceived = usdcAfter - usdcBefore;
    
    console.log(`\nUSDC After: ${Number(usdcAfter) / 1e6} USDC`);
    console.log(`USDC Received: ${Number(usdcReceived) / 1e6} USDC`);

    // Check remaining ETH
    const ethAfter = await provider.getBalance(wallet.address);
    console.log(`ETH After: ${ethers.formatEther(ethAfter)} ETH`);

    console.log('\n✅ Swap complete! You can now test the vault deposit/withdrawal flow.');
    
  } catch (error: any) {
    console.error(`\n❌ Swap failed: ${error.message}`);
    
    if (error.message.includes('insufficient funds')) {
      console.log('\nTry with a smaller amount or ensure you have enough ETH for gas.');
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);

