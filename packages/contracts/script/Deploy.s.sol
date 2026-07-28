// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {HypeFuel} from "../src/HypeFuel.sol";

/// @notice Deploys HypeFuel to HyperEVM behind an ERC-1967 proxy.
///
/// @dev Run with:
///      `forge script script/Deploy.s.sol:Deploy --rpc-url hyperevm --broadcast`
///      Neither the constructor nor `initialize` reads a precompile, so the simulation forge
///      runs first is accurate.
contract Deploy is Script {
    /// @dev Circle's native USDC on HyperEVM.
    address internal constant NATIVE_USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    /// @dev Project X's USDC/WHYPE 0.05% pool: the deepest USDC/HYPE venue on HyperEVM, and
    ///      a faithful Uniswap V3 fork. Confirmed canonical via `factory.getPool`.
    address internal constant PROJECT_X_USDC_WHYPE_500 = 0x6c9A33E3b592C0d65B3Ba59355d5Be0d38259285;

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

    /// Refill inventory to 1.8 HYPE, about two back-to-back maximum-size fills. Sized to the
    /// capital actually deployed; raise both levels together as inventory grows.
    uint256 internal constant HYPE_TARGET = 1.8 ether;
    /// Rebalance once inventory falls to half the target, which still covers one $50 fill.
    uint256 internal constant HYPE_FLOOR = 0.9 ether;
    /// Matches the $1 order minimum, so a single small fill can be recycled.
    uint256 internal constant MIN_REBALANCE_USDC = 1e6;
    /// 1% tolerance against the oracle. Measured all-in cost on this pool is 5-13 bps, so
    /// this is loose enough never to block an honest rebalance and tight enough to make a
    /// manipulated one revert.
    uint256 internal constant MAX_REBALANCE_SLIPPAGE_BPS = 100;

    function run() external returns (HypeFuel fuel, address implementation) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("deployer:", deployer);
        console.log("balance :", deployer.balance);

        bytes memory initData = abi.encodeCall(
            HypeFuel.initialize,
            (deployer, NATIVE_USDC, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_ORACLE_DEVIATION_BPS)
        );

        vm.startBroadcast(deployerKey);

        implementation = address(new HypeFuel());
        // Initializing inside the proxy constructor leaves no window in which the proxy is
        // deployed but uninitialized.
        fuel = HypeFuel(payable(address(new ERC1967Proxy(implementation, initData))));

        fuel.setPool(PROJECT_X_USDC_WHYPE_500);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, MAX_REBALANCE_SLIPPAGE_BPS);

        vm.stopBroadcast();

        console.log("HypeFuel proxy         :", address(fuel));
        console.log("HypeFuel implementation:", implementation);
    }
}

/// @notice Upgrades an existing HypeFuel proxy to a freshly deployed implementation.
///
/// @dev Run with:
///      `PROXY=0x… forge script script/Deploy.s.sol:Upgrade --rpc-url hyperevm --broadcast`
///      The implementation holds no state, so it takes no constructor arguments and nothing
///      needs re-supplying at upgrade time.
contract Upgrade is Script {
    function run() external returns (address implementation) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        HypeFuel fuel = HypeFuel(payable(vm.envAddress("PROXY")));

        address usdcBefore = address(fuel.usdc());
        address ownerBefore = fuel.owner();

        vm.startBroadcast(deployerKey);
        implementation = address(new HypeFuel());
        fuel.upgradeToAndCall(implementation, "");
        vm.stopBroadcast();

        require(address(fuel.usdc()) == usdcBefore, "usdc moved");
        require(fuel.owner() == ownerBefore, "owner moved");

        console.log("HypeFuel implementation:", implementation);
    }
}
