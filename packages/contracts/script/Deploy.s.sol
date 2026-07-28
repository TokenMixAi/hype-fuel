// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HypeFuel} from "../src/HypeFuel.sol";

/// @notice Deploys HypeFuel to HyperEVM.
///
/// @dev Run with:
///      `forge script script/Deploy.s.sol:Deploy --rpc-url hyperevm --broadcast`
///      The constructor reads no precompiles, so the simulation forge runs first is accurate.
contract Deploy is Script {
    /// @dev Circle's native USDC on HyperEVM.
    address internal constant NATIVE_USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    /// 3% fee.
    uint256 internal constant FEE_BPS = 300;
    /// $0.15 floor, so dust orders still cover fixed costs.
    uint256 internal constant MIN_FEE_USDC = 0.15e6;
    /// $1 minimum order.
    uint256 internal constant MIN_ORDER_USDC = 1e6;
    /// $50 maximum, capping inventory and oracle exposure per fill.
    uint256 internal constant MAX_ORDER_USDC = 50e6;
    /// Allow 5% between the perp oracle and spot before refusing to quote.
    uint256 internal constant MAX_ORACLE_DEVIATION_BPS = 500;

    function run() external returns (HypeFuel fuel) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("deployer:", deployer);
        console.log("balance :", deployer.balance);

        vm.startBroadcast(deployerKey);
        fuel = new HypeFuel(
            deployer, NATIVE_USDC, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_ORACLE_DEVIATION_BPS
        );
        vm.stopBroadcast();

        console.log("HypeFuel deployed at:", address(fuel));
    }
}
