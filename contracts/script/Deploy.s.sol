// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BloomStrategyVault.sol";
import "../src/DeltaNeutralStrategy.sol";
import "../src/LiquidityRangeManager.sol";
import "../src/CollateralManager.sol";

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        // Get keeper address from env (optional)
        address keeperAddress = vm.envOr("KEEPER_ADDRESS", address(0));
        
        // Base Mainnet Addresses
        address usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
        address weth = 0x4200000000000000000000000000000000000006;
        address pool = 0x4F8d9A26ae95f14a179439a2a0b3431e52940496; // WETH/USDC 1% (48.35% base APR, higher with concentration)
        address nfpm = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1; // Uniswap NFT Position Manager
        address aavePool = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; // Aave V3 Pool
        address router = 0x2626664c2603336E57B271c5C0b26F421741e481; // Uniswap SwapRouter02

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy Managers
        console.log("Deploying Liquidity Range Manager...");
        LiquidityRangeManager lrm = new LiquidityRangeManager(nfpm);
        console.log("Deploying Collateral Manager...");
        CollateralManager cm = new CollateralManager(aavePool);
        
        // 2. Deploy Vault
        console.log("Deploying Bloom Strategy Vault...");
        BloomStrategyVault vault = new BloomStrategyVault(IERC20(usdc), address(0));
        
        // 3. Deploy Strategy
        console.log("Deploying Delta Neutral Strategy...");
        DeltaNeutralStrategy strategy = new DeltaNeutralStrategy(
            address(vault),
            address(lrm),
            address(cm),
            router,
            pool,
            usdc,
            weth
        );
        
        // 4. Register Strategy with Vault
        console.log("Registering strategy with vault...");
        vault.registerStrategy(address(strategy));
        
        // 5. Set up Keeper Role
        if (keeperAddress != address(0)) {
            console.log("Setting up keeper role for:", keeperAddress);
            strategy.setKeeper(keeperAddress, true);
            console.log("Keeper authorized successfully");
        } else {
            console.log("WARNING: No keeper address provided. Set KEEPER_ADDRESS in .env");
            console.log("You'll need to call strategy.setKeeper(keeperAddress, true) manually");
        }
        
        vm.stopBroadcast();
        
        console.log("LiquidityRangeManager:", address(lrm));
        console.log("CollateralManager:", address(cm));
        console.log("BloomStrategyVault:", address(vault));
        console.log("DeltaNeutralStrategy:", address(strategy));

        // Write addresses to JSON file
        string memory json = "key";
        vm.serializeAddress(json, "LiquidityRangeManager", address(lrm));
        vm.serializeAddress(json, "CollateralManager", address(cm));
        vm.serializeAddress(json, "BloomStrategyVault", address(vault));
        string memory finalJson = vm.serializeAddress(json, "DeltaNeutralStrategy", address(strategy));
        
        console.log("\n=== COPY THIS JSON ===");
        console.log(finalJson);
        console.log("=== END JSON ===\n");
    }
}


