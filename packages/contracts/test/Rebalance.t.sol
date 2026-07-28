// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @notice Inventory rebalancing: buying HYPE with accumulated USDC.
///
/// @dev These run against a mock pool so execution price can be driven directly; the fork
///      suite proves the same code path works against Project X's real pool.
contract RebalanceTest is BaseTest {
    uint256 internal constant BPS = 10_000;

    MockUSDC internal token;
    MockV3Pool internal pool;

    function setUp() public {
        token = new MockUSDC();
        usdc = address(token);
        (user, userPk) = makeAddrAndKey("user");

        // The contract hardcodes WHYPE's address, so put a wrapper there.
        vm.etch(WHYPE, address(new MockWHYPE()).code);

        // Token ordering matches the real Project X pool, where WHYPE is token0.
        pool = new MockV3Pool(WHYPE, usdc);
        pool.setPrice(PRICE_1E8);

        fuel = _deployFuel();
        domainSeparator = token.DOMAIN_SEPARATOR();

        vm.startPrank(owner);
        fuel.setPool(address(pool));
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);
        vm.stopPrank();

        _setPrice(PRICE_1E8);
        _stockPool(address(pool), 10_000 ether);

        // Inventory drawn down below the floor, with USDC banked from earlier fills.
        vm.deal(address(fuel), 5 ether);
        token.mint(address(fuel), 2_000e6);
    }

    /// @dev Wraps native HYPE and hands it to `pool_` so it has something to sell.
    function _stockPool(address pool_, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        MockWHYPE(payable(WHYPE)).deposit{value: amount}();
        MockWHYPE(payable(WHYPE)).transfer(pool_, amount);
    }

    /// @dev USDC a rebalance should spend to close the gap to the target, computed
    ///      independently of the contract.
    function _expectedUsdcIn(uint256 hypeBalance, uint256 priceUsd1e8) internal pure returns (uint256) {
        return ((HYPE_TARGET - hypeBalance) * priceUsd1e8) / 1e20;
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_rebalance_buysInventoryWithAccumulatedUsdc() public {
        uint256 expectedUsdcIn = _expectedUsdcIn(5 ether, PRICE_1E8);

        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        assertEq(usdcIn, expectedUsdcIn, "spent exactly the deficit's worth");
        assertEq(usdcIn, 827.205e6, "$827.205 buys the 15 HYPE shortfall at $55.147");
        assertEq(hypeOut, 15 ether, "bought the shortfall");
        assertEq(address(fuel).balance, HYPE_TARGET, "inventory back at target");
        assertEq(token.balanceOf(address(fuel)), 2_000e6 - expectedUsdcIn, "usdc debited");
    }

    /// @dev Inventory must arrive as native HYPE, not as a wrapped balance.
    function test_rebalance_deliversNativeHype() public {
        fuel.rebalance();

        assertEq(address(fuel).balance, HYPE_TARGET, "native balance grew");
        assertEq(MockWHYPE(payable(WHYPE)).balanceOf(address(fuel)), 0, "nothing left wrapped");
    }

    function test_rebalance_emitsRebalanced() public {
        uint256 expectedUsdcIn = _expectedUsdcIn(5 ether, PRICE_1E8);

        vm.expectEmit(true, false, false, true, address(fuel));
        emit HypeFuel.Rebalanced(relayer, expectedUsdcIn, 15 ether, PRICE_1E8);

        vm.prank(relayer);
        fuel.rebalance();
    }

    /// @dev The whole point of leaving this unpermissioned: whoever wants inventory to exist
    ///      can create it.
    function test_rebalance_isPermissionless() public {
        vm.prank(makeAddr("passerby"));
        (, uint256 hypeOut) = fuel.rebalance();

        assertEq(hypeOut, 15 ether, "any caller may rebalance");
    }

    /// @dev The scenario the design exists for: a fill that cannot be served becomes servable
    ///      after anyone rebalances, with no privileged key involved.
    function test_rebalance_unblocksAFillThatRanOutOfInventory() public {
        vm.deal(address(fuel), 0.1 ether);
        token.mint(user, 1_000e6);

        HypeFuel.Order memory order = _order(50e6, 0);
        bytes memory signature = _sign(order, userPk);
        uint256 expectedHype = _expectedHypeOut(50e6, PRICE_1E8);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.InsufficientLiquidity.selector, expectedHype, 0.1 ether));
        vm.prank(relayer);
        fuel.fill(order, signature);

        vm.prank(makeAddr("passerby"));
        fuel.rebalance();

        vm.prank(relayer);
        assertEq(fuel.fill(order, signature), expectedHype, "fill served after the rebalance");
    }

    /*//////////////////////////////////////////////////////////////
                          TRIGGERING AND SIZING
    //////////////////////////////////////////////////////////////*/

    function test_rebalance_allowedAtExactlyTheFloor() public {
        vm.deal(address(fuel), HYPE_FLOOR);

        (uint256 usdcIn,) = fuel.rebalance();
        assertEq(usdcIn, _expectedUsdcIn(HYPE_FLOOR, PRICE_1E8), "the floor is inclusive");
    }

    function test_rebalance_revertsWhenInventoryIsHealthy() public {
        vm.deal(address(fuel), HYPE_FLOOR + 1);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.RebalanceNotNeeded.selector, HYPE_FLOOR + 1, HYPE_FLOOR));
        fuel.rebalance();
    }

    /// @dev Hysteresis: one rebalance lifts the balance clear of the floor, so a caller cannot
    ///      chain swaps and bleed the pool fee.
    function test_rebalance_cannotBeRepeatedImmediately() public {
        fuel.rebalance();

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.RebalanceNotNeeded.selector, HYPE_TARGET, HYPE_FLOOR));
        fuel.rebalance();
    }

    function test_rebalance_capsSpendAtTheUsdcHeld() public {
        uint256 held = 300e6;
        deal(address(token), address(fuel), held);

        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        assertEq(usdcIn, held, "spent everything available, no more");
        assertEq(token.balanceOf(address(fuel)), 0, "usdc fully deployed");
        assertLt(address(fuel).balance, HYPE_TARGET, "target not reached, which is fine");
        assertEq(address(fuel).balance, 5 ether + hypeOut, "inventory grew by the purchase");
    }

    function test_rebalance_revertsWhenAmountIsBelowTheMinimum() public {
        deal(address(token), address(fuel), MIN_REBALANCE_USDC - 1);

        vm.expectRevert(
            abi.encodeWithSelector(HypeFuel.RebalanceTooSmall.selector, MIN_REBALANCE_USDC - 1, MIN_REBALANCE_USDC)
        );
        fuel.rebalance();
    }

    function test_rebalance_revertsWhenNoUsdcIsHeld() public {
        deal(address(token), address(fuel), 0);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.RebalanceTooSmall.selector, 0, MIN_REBALANCE_USDC));
        fuel.rebalance();
    }

    /*//////////////////////////////////////////////////////////////
                     PRICE MANIPULATION AND SLIPPAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev The core safety property. The pool price is untrusted, so a skewed pool has to make
    ///      the rebalance revert rather than buy HYPE expensively.
    function test_rebalance_revertsWhenPoolIsManipulated() public {
        pool.setExecutionPenaltyBps(REBALANCE_SLIPPAGE_BPS + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                HypeFuel.InsufficientOutput.selector,
                (15 ether * (BPS - REBALANCE_SLIPPAGE_BPS - 1)) / BPS,
                (15 ether * (BPS - REBALANCE_SLIPPAGE_BPS)) / BPS
            )
        );
        fuel.rebalance();

        assertEq(address(fuel).balance, 5 ether, "no inventory bought");
        assertEq(token.balanceOf(address(fuel)), 2_000e6, "no usdc spent");
    }

    function test_rebalance_acceptsExecutionAtTheToleranceBoundary() public {
        pool.setExecutionPenaltyBps(REBALANCE_SLIPPAGE_BPS);

        (, uint256 hypeOut) = fuel.rebalance();
        assertEq(hypeOut, (15 ether * (BPS - REBALANCE_SLIPPAGE_BPS)) / BPS, "boundary is inclusive");
    }

    /// @dev A swap that filled only part of the input delivers proportionally less HYPE, which
    ///      the same output bound catches.
    function test_rebalance_revertsOnPartialFill() public {
        pool.setPartialFillUsdc(400e6);

        vm.expectRevert();
        fuel.rebalance();

        assertEq(address(fuel).balance, 5 ether, "no inventory bought");
    }

    /// @dev Buying HYPE, the conservative feed is the lower one. Pricing the bound off the
    ///      higher feed would let this swap through; it must not.
    function test_rebalance_boundsAgainstTheLowerFeed() public {
        _setPrices(50e8, 52e8);
        pool.setPrice(52e8);

        vm.expectRevert(
            abi.encodeWithSelector(
                HypeFuel.InsufficientOutput.selector,
                (_expectedUsdcIn(5 ether, 50e8) * 1e20) / 52e8,
                (_expectedUsdcIn(5 ether, 50e8) * 1e20 * (BPS - REBALANCE_SLIPPAGE_BPS)) / (50e8 * BPS)
            )
        );
        fuel.rebalance();
    }

    /// @dev Sizing uses the lower feed too, so a divergence never overspends.
    function test_rebalance_sizesAgainstTheLowerFeed() public {
        _setPrices(50e8, 52e8);
        pool.setPrice(50e8);

        (uint256 usdcIn,) = fuel.rebalance();
        assertEq(usdcIn, _expectedUsdcIn(5 ether, 50e8), "priced off the lower feed");
    }

    function test_rebalance_revertsWhenFeedsDivergeTooFar() public {
        _setPrices(50e8, 53e8);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.OracleDeviation.selector, 50e8, 53e8));
        fuel.rebalance();
    }

    function test_rebalance_revertsWhenOracleIsUnavailable() public {
        _setPrices(0, 50e8);

        vm.expectRevert(HypeFuel.OracleUnavailable.selector);
        fuel.rebalance();
    }

    /*//////////////////////////////////////////////////////////////
                          GATING AND CALLBACK
    //////////////////////////////////////////////////////////////*/

    function test_rebalance_revertsWhenPaused() public {
        vm.prank(owner);
        fuel.setPaused(true);

        vm.expectRevert(HypeFuel.Paused.selector);
        fuel.rebalance();
    }

    function test_rebalance_revertsWhenPoolIsNotSet() public {
        vm.prank(owner);
        fuel.setPool(address(0));

        vm.expectRevert(HypeFuel.PoolNotSet.selector);
        fuel.rebalance();
    }

    /// @dev The callback pays out USDC, so nothing but the configured pool may invoke it.
    function test_callback_rejectsAnyCallerButThePool() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(HypeFuel.UnauthorizedCallback.selector);
        fuel.uniswapV3SwapCallback(0, int256(1_000e6), "");

        assertEq(token.balanceOf(address(fuel)), 2_000e6, "no usdc left the contract");
    }

    function test_rebalance_worksWhenUsdcIsToken0() public {
        MockV3Pool reversed = new MockV3Pool(usdc, WHYPE);
        reversed.setPrice(PRICE_1E8);
        _stockPool(address(reversed), 100 ether);

        vm.prank(owner);
        fuel.setPool(address(reversed));
        assertTrue(fuel.usdcIsToken0(), "ordering detected");

        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        assertEq(usdcIn, _expectedUsdcIn(5 ether, PRICE_1E8), "same amount either ordering");
        assertEq(hypeOut, 15 ether, "same output either ordering");
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_pendingRebalanceUsdc_reportsWhatARebalanceWouldSpend() public {
        assertEq(fuel.pendingRebalanceUsdc(), _expectedUsdcIn(5 ether, PRICE_1E8), "amount reported");

        (uint256 usdcIn,) = fuel.rebalance();
        assertEq(usdcIn, _expectedUsdcIn(5 ether, PRICE_1E8), "view agreed with the call");
        assertEq(fuel.pendingRebalanceUsdc(), 0, "nothing pending afterwards");
    }

    function test_pendingRebalanceUsdc_zeroWhenNotActionable() public {
        vm.deal(address(fuel), HYPE_TARGET);
        assertEq(fuel.pendingRebalanceUsdc(), 0, "inventory healthy");

        vm.deal(address(fuel), 5 ether);
        deal(address(token), address(fuel), MIN_REBALANCE_USDC - 1);
        assertEq(fuel.pendingRebalanceUsdc(), 0, "below the minimum size");

        vm.prank(owner);
        fuel.setPaused(true);
        assertEq(fuel.pendingRebalanceUsdc(), 0, "paused");
    }

    function test_rebalanceConfig_reportsSettings() public view {
        (
            address pool_,
            bool usdcIsToken0_,
            uint256 hypeTarget_,
            uint256 hypeFloor_,
            uint256 minRebalanceUsdc_,
            uint256 maxRebalanceSlippageBps_,
            uint256 usdcBalance
        ) = fuel.rebalanceConfig();

        assertEq(pool_, address(pool), "pool");
        assertFalse(usdcIsToken0_, "whype is token0 in this pool");
        assertEq(hypeTarget_, HYPE_TARGET, "target");
        assertEq(hypeFloor_, HYPE_FLOOR, "floor");
        assertEq(minRebalanceUsdc_, MIN_REBALANCE_USDC, "minimum");
        assertEq(maxRebalanceSlippageBps_, REBALANCE_SLIPPAGE_BPS, "slippage");
        assertEq(usdcBalance, 2_000e6, "usdc held");
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    function test_setPool_rejectsAPoolThatIsNotUsdcWhype() public {
        MockUSDC other = new MockUSDC();
        address wrongStable = address(new MockV3Pool(address(other), WHYPE));
        address wrongHype = address(new MockV3Pool(usdc, address(other)));

        vm.startPrank(owner);

        vm.expectRevert(HypeFuel.InvalidPool.selector);
        fuel.setPool(wrongStable);

        vm.expectRevert(HypeFuel.InvalidPool.selector);
        fuel.setPool(wrongHype);

        vm.stopPrank();
    }

    function test_setPool_emitsUpdate() public {
        vm.expectEmit(false, false, false, true, address(fuel));
        emit HypeFuel.PoolUpdated(address(0), false);

        vm.prank(owner);
        fuel.setPool(address(0));
    }

    function test_setRebalanceConfig_validatesInputs() public {
        uint256 aboveMaxSlippage = fuel.MAX_REBALANCE_SLIPPAGE_BPS() + 1;

        vm.startPrank(owner);

        // Floor must sit strictly below target.
        vm.expectRevert(HypeFuel.InvalidRebalanceConfig.selector);
        fuel.setRebalanceConfig(10 ether, 10 ether, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);

        vm.expectRevert(HypeFuel.InvalidRebalanceConfig.selector);
        fuel.setRebalanceConfig(10 ether, 11 ether, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);

        vm.expectRevert(HypeFuel.InvalidRebalanceConfig.selector);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, 0, REBALANCE_SLIPPAGE_BPS);

        vm.expectRevert(HypeFuel.InvalidRebalanceConfig.selector);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, 0);

        vm.expectRevert(HypeFuel.InvalidRebalanceConfig.selector);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, aboveMaxSlippage);

        vm.stopPrank();
    }

    function test_admin_rebalanceSettersAreOwnerOnly() public {
        vm.startPrank(makeAddr("notOwner"));

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setPool(address(pool));

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);

        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev However the pool behaves, a rebalance either lands within tolerance of the oracle
    ///      price or leaves the contract untouched.
    function testFuzz_rebalance_eitherClearsTheOracleBoundOrRevertsCleanly(uint256 penaltyBps, uint256 hypeBalance)
        public
    {
        pool.setExecutionPenaltyBps(bound(penaltyBps, 0, 5_000));
        hypeBalance = bound(hypeBalance, 0, HYPE_FLOOR);

        vm.deal(address(fuel), hypeBalance);
        deal(address(token), address(fuel), 100_000e6);

        try fuel.rebalance() returns (uint256 usdcIn, uint256 hypeOut) {
            // Divides once at the end, as the contract does. Converting to HYPE first and applying
            // the slippage second discards a wei that the multiplication by BPS then scales up to
            // nearly BPS, so the bound came out up to 9,999 too strict and some inputs tripped it.
            uint256 minAcceptable = (usdcIn * 1e20 * (BPS - REBALANCE_SLIPPAGE_BPS)) / (PRICE_1E8 * BPS);
            assertGe(hypeOut, minAcceptable, "within tolerance");
            assertEq(address(fuel).balance, hypeBalance + hypeOut, "inventory grew by exactly the purchase");
            assertEq(token.balanceOf(address(fuel)), 100_000e6 - usdcIn, "usdc fell by exactly the spend");
        } catch {
            assertEq(address(fuel).balance, hypeBalance, "a failed rebalance moves nothing");
            assertEq(token.balanceOf(address(fuel)), 100_000e6, "a failed rebalance moves nothing");
        }
    }

    receive() external payable {}
}
