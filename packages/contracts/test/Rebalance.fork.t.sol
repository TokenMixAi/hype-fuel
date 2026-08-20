// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {IEIP3009} from "../src/interfaces/IEIP3009.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3Pool.sol";
import {PrecompileSimulator} from "@hyper-evm-lib/test/utils/PrecompileSimulator.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice Pushes the real pool's price around, so manipulation resistance can be tested
///         against genuine liquidity rather than a mock.
contract PoolSkewer {
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address internal immutable pool;

    constructor(address pool_) {
        pool = pool_;
    }

    /// @dev Buys HYPE with `usdcIn`, driving the HYPE price up.
    function buyHype(uint256 usdcIn) external {
        IUniswapV3Pool(pool).swap(address(this), false, int256(usdcIn), MAX_SQRT_RATIO - 1, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) SafeTransferLib.safeTransfer(IUniswapV3Pool(pool).token0(), pool, uint256(amount0Delta));
        if (amount1Delta > 0) SafeTransferLib.safeTransfer(IUniswapV3Pool(pool).token1(), pool, uint256(amount1Delta));
    }
}

/// @notice Fork tests for {HypeFuel.rebalance} against Project X's real USDC/WHYPE pool.
///
/// @dev The hermetic suite drives execution price directly through a mock. These tests exist
///      to prove the same code path works against real liquidity, the real wrapper contract
///      and the live oracle -- and that real depth is enough for the configured tolerance.
contract RebalanceForkTest is BaseTest {
    /// @dev Circle's native USDC on HyperEVM.
    address internal constant NATIVE_USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    /// @dev Project X's USDC/WHYPE 0.05% pool, the deepest USDC/HYPE venue on HyperEVM.
    address internal constant PROJECT_X_USDC_WHYPE_500 = 0x6c9A33E3b592C0d65B3Ba59355d5Be0d38259285;

    function setUp() public {
        vm.createSelectFork("hyperevm");
        PrecompileSimulator.init();

        usdc = NATIVE_USDC;
        (user, userPk) = makeAddrAndKey("forkUser");

        fuel = _deployFuel();
        domainSeparator = IEIP3009(usdc).DOMAIN_SEPARATOR();

        vm.startPrank(owner);
        fuel.setPool(PROJECT_X_USDC_WHYPE_500);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);
        vm.stopPrank();

        // Inventory drawn down below the floor, with USDC banked from earlier fills.
        vm.deal(address(fuel), 5 ether);
        deal(usdc, address(fuel), 5_000e6);
    }

    /// @dev Sanity check that the pool we configured is the pair we think it is.
    function test_fork_poolIsTheRealUsdcWhypePair() public view {
        assertEq(IUniswapV3Pool(PROJECT_X_USDC_WHYPE_500).token0(), WHYPE, "token0 is WHYPE");
        assertEq(IUniswapV3Pool(PROJECT_X_USDC_WHYPE_500).token1(), NATIVE_USDC, "token1 is USDC");
        assertFalse(fuel.usdcIsToken0(), "ordering cached correctly");
    }

    /// @dev The full loop against real liquidity: accumulated USDC becomes native inventory.
    function test_fork_rebalanceBuysRealInventory() public {
        uint256 usdcBefore = IEIP3009(usdc).balanceOf(address(fuel));

        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        assertEq(IEIP3009(usdc).balanceOf(address(fuel)), usdcBefore - usdcIn, "usdc spent");
        assertEq(address(fuel).balance, 5 ether + hypeOut, "inventory grew by the purchase");
        assertApproxEqRel(address(fuel).balance, HYPE_TARGET, 0.02e18, "landed near the target");

        emit log_named_decimal_uint("usdc spent", usdcIn, 6);
        emit log_named_decimal_uint("hype bought", hypeOut, 18);
    }

    /// @dev How closely the real pool tracks the oracle is exactly what
    ///      `maxRebalanceSlippageBps` has to be calibrated against, so it is worth asserting
    ///      rather than assuming.
    ///
    /// @dev The band is two-sided because the live feeds can tick between this read and the
    ///      rebalance, putting the pool's output marginally either side of the value computed
    ///      here.
    function test_fork_realExecutionTracksTheOracle() public {
        uint256 price = fuel.hypePriceUsd1e8();

        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        uint256 oracleImplied = (usdcIn * 1e20) / price;
        assertApproxEqRel(hypeOut, oracleImplied, 0.005e18, "pool tracks the oracle inside 50 bps");

        emit log_named_decimal_uint("oracle-implied HYPE", oracleImplied, 18);
        emit log_named_decimal_uint("pool-delivered HYPE", hypeOut, 18);
    }

    /// @dev Unwrapping must go through the real WHYPE contract, not just our mock of it.
    function test_fork_proceedsArriveAsNativeHype() public {
        fuel.rebalance();

        assertEq(SafeTransferLib.balanceOf(WHYPE, address(fuel)), 0, "nothing left wrapped");
        assertGt(address(fuel).balance, 5 ether, "native inventory grew");
    }

    /// @dev The manipulation case, against real liquidity. Skewing the pool far enough to
    ///      matter must make the rebalance revert rather than buy HYPE expensively, because
    ///      the bound comes from HyperCore rather than from the pool.
    function test_fork_rebalanceRevertsAgainstAManipulatedPool() public {
        PoolSkewer skewer = new PoolSkewer(PROJECT_X_USDC_WHYPE_500);
        deal(usdc, address(skewer), 3_000_000e6);
        skewer.buyHype(3_000_000e6);

        vm.expectRevert();
        fuel.rebalance();

        assertEq(address(fuel).balance, 5 ether, "no inventory bought at a bad price");
        assertEq(IEIP3009(usdc).balanceOf(address(fuel)), 5_000e6, "no usdc spent");
    }

    /// @dev A skew too small to breach the tolerance should still go through, so the guard is
    ///      not simply rejecting everything.
    function test_fork_rebalanceToleratesASmallSkew() public {
        PoolSkewer skewer = new PoolSkewer(PROJECT_X_USDC_WHYPE_500);
        deal(usdc, address(skewer), 20_000e6);
        skewer.buyHype(20_000e6);

        (, uint256 hypeOut) = fuel.rebalance();
        assertGt(hypeOut, 0, "an ordinary market move does not block rebalancing");
    }

    /// @dev End to end at live prices: fills drain inventory, a rebalance restores it.
    function test_fork_fillThenRebalanceCycle() public {
        deal(usdc, user, 1_000e6);
        vm.deal(address(fuel), 1 ether);

        HypeFuel.Order memory order = _order(50e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(relayer);
        uint256 filled = fuel.fill(order, signature);
        assertGt(filled, 0, "fill served");

        uint256 inventoryAfterFill = address(fuel).balance;
        fuel.rebalance();

        assertGt(address(fuel).balance, inventoryAfterFill, "rebalance restored inventory");
        assertApproxEqRel(address(fuel).balance, HYPE_TARGET, 0.02e18, "back near target");
    }
}
