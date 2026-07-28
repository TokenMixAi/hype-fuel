// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReenteringWallet, RejectingWallet} from "./mocks/Wallets.sol";
import {Ownable} from "solady/auth/Ownable.sol";

contract HypeFuelTest is BaseTest {
    MockUSDC internal token;

    function setUp() public {
        token = new MockUSDC();
        usdc = address(token);

        (user, userPk) = makeAddrAndKey("user");

        fuel = new HypeFuel(owner, usdc, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_DEVIATION_BPS);
        domainSeparator = token.DOMAIN_SEPARATOR();

        _setPrice(PRICE_1E8);
        token.mint(user, 1_000e6);
        vm.deal(address(fuel), 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                              HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_fill_deliversHypeAndTakesUsdc() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        uint256 expectedHype = _expectedHypeOut(10e6, PRICE_1E8);
        uint256 userHypeBefore = user.balance;
        uint256 fuelUsdcBefore = token.balanceOf(address(fuel));

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        assertEq(hypeOut, expectedHype, "hype out");
        assertEq(user.balance - userHypeBefore, expectedHype, "user received hype");
        assertEq(token.balanceOf(user), 990e6, "user usdc debited");
        assertEq(token.balanceOf(address(fuel)) - fuelUsdcBefore, 10e6, "contract received usdc");
    }

    /// @dev Pins the conversion against a hand-checked value: $10 minus a 3% fee is $9.70,
    ///      and 9.70 / 55.147 = 0.17589352095... HYPE.
    function test_fill_pricingMatchesHandComputedValue() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        assertEq(hypeOut, 175_893_520_953_089_016, "0.17589 HYPE for $9.70 at $55.147");
        // Cross-check the round trip in USD terms, tolerating integer truncation.
        assertApproxEqAbs((hypeOut * PRICE_1E8) / 1e20, 9.7e6, 1, "usd value round trip");
    }

    /// @dev Keeps the locally computed commitment in lockstep with the contract's.
    function test_orderNonce_matchesContract() public view {
        HypeFuel.Order memory order = _order(10e6, 123);
        assertEq(_orderNonce(order), fuel.orderNonce(order), "local and on-chain nonce agree");
    }

    /// @dev Cross-language vector. The TypeScript SDK asserts these same two constants, so a
    ///      divergence in either encoder is caught here rather than by rejected signatures
    ///      in production.
    function test_orderNonce_matchesSdkVector() public view {
        HypeFuel.Order memory order = HypeFuel.Order({
            user: 0x00000000000000000000000000000000000000A1,
            usdcIn: 10_000_000,
            minHypeOut: 175_000_000_000_000_000,
            validAfter: 1_700_000_000,
            validBefore: 1_700_000_300,
            salt: bytes32(uint256(0xab))
        });

        assertEq(fuel.ORDER_TYPEHASH(), 0xd192ad1848188705258a695bfe11d9a874fcd7cad62c16b4a34ed4fcfb53fadb, "typehash");
        assertEq(
            fuel.orderNonce(order),
            0x88617cefca486877573b0f731489b6fc12e46eaaa72ebf023d47f8ac762163f5,
            "nonce vector shared with the SDK"
        );
    }

    function test_fill_isPermissionless() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(makeAddr("randomRelayer"));
        fuel.fill(order, signature);

        assertGt(user.balance, 0, "any caller can relay");
    }

    function test_fill_emitsFilled() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        uint256 expectedHype = _expectedHypeOut(10e6, PRICE_1E8);

        vm.expectEmit(true, true, false, true, address(fuel));
        emit HypeFuel.Filled(user, relayer, 10e6, 0.3e6, expectedHype, PRICE_1E8, fuel.orderNonce(order));

        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_honoursMinHypeOut() public {
        uint256 expected = _expectedHypeOut(10e6, PRICE_1E8);
        HypeFuel.Order memory order = _order(10e6, expected);

        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        assertEq(fuel.fill(order, signature_), expected, "exact min accepted");
    }

    /*//////////////////////////////////////////////////////////////
                       COMMITMENT: TAMPERING FAILS
    //////////////////////////////////////////////////////////////*/

    /// @dev The heart of the design. `minHypeOut` is not an EIP-3009 field, so it is bound only
    ///      through the derived nonce. Raising it after signing must invalidate the signature.
    function test_fill_revertsWhenMinHypeOutTampered() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        order.minHypeOut = 1;

        vm.expectRevert("FiatTokenV2: invalid signature");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    function test_fill_revertsWhenSaltTampered() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        order.salt = keccak256("different");

        vm.expectRevert("FiatTokenV2: invalid signature");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    function test_fill_revertsWhenUsdcInTampered() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        order.usdcIn = 20e6;

        vm.expectRevert("FiatTokenV2: invalid signature");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    function test_fill_revertsWhenUserTampered() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        order.user = makeAddr("attacker");

        vm.expectRevert("FiatTokenV2: invalid signature");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    function test_fill_revertsWhenSignedByWrongKey() public {
        (, uint256 attackerPk) = makeAddrAndKey("attacker");
        HypeFuel.Order memory order = _order(10e6, 0);

        vm.expectRevert("FiatTokenV2: invalid signature");
        bytes memory signature_ = _sign(order, attackerPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsOnReplay() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(relayer);
        fuel.fill(order, signature);

        assertTrue(fuel.isOrderUsed(order), "nonce consumed");

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    /// @dev The salt exists so a user can repeat an identical top-up.
    function test_fill_saltAllowsRepeatOrders() public {
        HypeFuel.Order memory first = _order(10e6, 0);
        bytes memory signature_ = _sign(first, userPk);
        vm.prank(relayer);
        fuel.fill(first, signature_);

        HypeFuel.Order memory second = first;
        second.salt = keccak256("second");
        bytes memory secondSignature = _sign(second, userPk);
        vm.prank(relayer);
        fuel.fill(second, secondSignature);

        assertEq(token.balanceOf(user), 980e6, "both orders settled");
    }

    /*//////////////////////////////////////////////////////////////
                          VALIDATION & LIMITS
    //////////////////////////////////////////////////////////////*/

    function test_fill_revertsWhenExpired() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.warp(order.validBefore);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.OrderExpired.selector, order.validBefore));
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    function test_fill_revertsWhenNotYetValid() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        order.validAfter = block.timestamp + 100;
        order.validBefore = block.timestamp + 400;

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.OrderNotYetValid.selector, order.validAfter));
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsBelowMinimum() public {
        HypeFuel.Order memory order = _order(MIN_ORDER_USDC - 1, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                HypeFuel.OrderSizeOutOfRange.selector, MIN_ORDER_USDC - 1, MIN_ORDER_USDC, MAX_ORDER_USDC
            )
        );
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsAboveMaximum() public {
        HypeFuel.Order memory order = _order(MAX_ORDER_USDC + 1, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                HypeFuel.OrderSizeOutOfRange.selector, MAX_ORDER_USDC + 1, MIN_ORDER_USDC, MAX_ORDER_USDC
            )
        );
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsWhenOutputBelowMin() public {
        uint256 expected = _expectedHypeOut(10e6, PRICE_1E8);
        HypeFuel.Order memory order = _order(10e6, expected + 1);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.InsufficientOutput.selector, expected, expected + 1));
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsWhenInventoryTooLow() public {
        vm.deal(address(fuel), 0.01 ether);
        HypeFuel.Order memory order = _order(10e6, 0);
        uint256 expected = _expectedHypeOut(10e6, PRICE_1E8);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.InsufficientLiquidity.selector, expected, 0.01 ether));
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsWhenPaused() public {
        vm.prank(owner);
        fuel.setPaused(true);

        HypeFuel.Order memory order = _order(10e6, 0);

        vm.expectRevert(HypeFuel.Paused.selector);
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    function test_fill_revertsWhenUserLacksUsdc() public {
        vm.prank(user);
        token.transfer(makeAddr("elsewhere"), 1_000e6);

        HypeFuel.Order memory order = _order(10e6, 0);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);
    }

    /*//////////////////////////////////////////////////////////////
                                ORACLE
    //////////////////////////////////////////////////////////////*/

    function test_price_usesHigherOfTheTwoFeeds() public {
        _setPrices(50e8, 51e8);
        assertEq(fuel.hypePriceUsd1e8(), 51e8, "prices at the higher feed");

        _setPrices(52e8, 51e8);
        assertEq(fuel.hypePriceUsd1e8(), 52e8, "prices at the higher feed");
    }

    /// @dev Pushing a single feed down must not yield extra HYPE.
    function test_price_manipulatingOneFeedDownDoesNotIncreaseOutput() public {
        _setPrice(50e8);
        (uint256 baseline,,) = fuel.quote(10e6);

        _setPrices(49e8, 50e8);
        (uint256 spotPushedDown,,) = fuel.quote(10e6);
        assertEq(spotPushedDown, baseline, "spot feed still anchors the price");

        _setPrices(50e8, 49e8);
        (uint256 oraclePushedDown,,) = fuel.quote(10e6);
        assertEq(oraclePushedDown, baseline, "oracle feed still anchors the price");
    }

    function test_price_revertsOnExcessiveDeviation() public {
        // 6% apart, above the 5% tolerance.
        _setPrices(50e8, 53e8);

        vm.expectRevert(abi.encodeWithSelector(HypeFuel.OracleDeviation.selector, 50e8, 53e8));
        fuel.hypePriceUsd1e8();
    }

    function test_price_allowsDeviationAtTolerance() public {
        // Exactly 5% above the lower feed.
        _setPrices(100e8, 105e8);
        assertEq(fuel.hypePriceUsd1e8(), 105e8, "boundary is inclusive");
    }

    function test_price_revertsWhenFeedIsZero() public {
        _setPrices(0, 50e8);
        vm.expectRevert(HypeFuel.OracleUnavailable.selector);
        fuel.hypePriceUsd1e8();

        _setPrices(50e8, 0);
        vm.expectRevert(HypeFuel.OracleUnavailable.selector);
        fuel.hypePriceUsd1e8();
    }

    /*//////////////////////////////////////////////////////////////
                                  FEES
    //////////////////////////////////////////////////////////////*/

    function test_fee_percentageAppliesAboveFloor() public view {
        assertEq(fuel.feeFor(10e6), 0.3e6, "3% of $10");
        assertEq(fuel.feeFor(50e6), 1.5e6, "3% of $50");
    }

    function test_fee_floorAppliesToDust() public view {
        // 3% of $1 is $0.03, below the $0.15 floor.
        assertEq(fuel.feeFor(1e6), MIN_FEE_USDC, "floor applies");
        // $5 is the crossover point where 3% equals the floor.
        assertEq(fuel.feeFor(5e6), MIN_FEE_USDC, "crossover");
        assertEq(fuel.feeFor(6e6), 0.18e6, "percentage takes over");
    }

    function test_fee_cannotExceedHardCap() public {
        uint256 aboveMaxBps = fuel.MAX_FEE_BPS() + 1;
        uint256 aboveMaxFlat = fuel.MAX_MIN_FEE_USDC() + 1;

        vm.prank(owner);
        vm.expectRevert(HypeFuel.InvalidFee.selector);
        fuel.setFee(aboveMaxBps, MIN_FEE_USDC);

        vm.prank(owner);
        vm.expectRevert(HypeFuel.InvalidFee.selector);
        fuel.setFee(FEE_BPS, aboveMaxFlat);
    }

    /*//////////////////////////////////////////////////////////////
                             ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    function test_admin_onlyOwner() public {
        address notOwner = makeAddr("notOwner");
        vm.startPrank(notOwner);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setFee(100, 0);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setOrderLimits(1e6, 2e6);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setMaxOracleDeviationBps(100);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.setPaused(true);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.withdrawHype(notOwner, 1);

        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.withdrawUsdc(notOwner, 1);

        vm.stopPrank();
    }

    function test_admin_withdrawals() public {
        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature_ = _sign(order, userPk);
        vm.prank(relayer);
        fuel.fill(order, signature_);

        address treasury = makeAddr("treasury");

        vm.prank(owner);
        fuel.withdrawUsdc(treasury, 10e6);
        assertEq(token.balanceOf(treasury), 10e6, "usdc withdrawn");

        uint256 hypeBalance = address(fuel).balance;
        vm.prank(owner);
        fuel.withdrawHype(treasury, hypeBalance);
        assertEq(treasury.balance, hypeBalance, "hype withdrawn");
        assertEq(address(fuel).balance, 0, "drained");
    }

    function test_admin_rejectsInvalidOrderLimits() public {
        vm.startPrank(owner);

        vm.expectRevert(HypeFuel.InvalidOrderLimits.selector);
        fuel.setOrderLimits(10e6, 5e6);

        // A minimum at or below the flat fee would permit zero-output fills.
        vm.expectRevert(HypeFuel.InvalidOrderLimits.selector);
        fuel.setOrderLimits(MIN_FEE_USDC, 50e6);

        vm.stopPrank();
    }

    function test_admin_rejectsInvalidDeviation() public {
        vm.startPrank(owner);

        vm.expectRevert(HypeFuel.InvalidDeviation.selector);
        fuel.setMaxOracleDeviationBps(0);

        vm.expectRevert(HypeFuel.InvalidDeviation.selector);
        fuel.setMaxOracleDeviationBps(10_001);

        vm.stopPrank();
    }

    function test_receive_acceptsHypeInventory() public {
        uint256 before = address(fuel).balance;
        address funder = makeAddr("funder");
        vm.deal(funder, 5 ether);

        vm.prank(funder);
        (bool ok,) = address(fuel).call{value: 5 ether}("");

        assertTrue(ok, "deposit accepted");
        assertEq(address(fuel).balance, before + 5 ether, "inventory grew");
    }

    /*//////////////////////////////////////////////////////////////
                         SMART CONTRACT WALLETS
    //////////////////////////////////////////////////////////////*/

    /// @dev USDC's `bytes` overload accepts ERC-1271 signatures, so contract wallets work.
    function test_fill_supportsErc1271Wallet() public {
        ReenteringWallet wallet = new ReenteringWallet(fuel, false);
        token.mint(address(wallet), 100e6);

        HypeFuel.Order memory order = _order(10e6, 0);
        order.user = address(wallet);

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, hex"");

        assertEq(hypeOut, _expectedHypeOut(10e6, PRICE_1E8), "contract wallet filled");
        assertEq(address(wallet).balance, hypeOut, "wallet received hype");
    }

    /// @dev A hostile recipient must not drain inventory by re-entering during HYPE delivery.
    ///      The queued order is independently valid (fresh salt, funded wallet), so only the
    ///      guard stops it -- the token's replay protection would not.
    function test_fill_blocksReentrancy() public {
        ReenteringWallet wallet = new ReenteringWallet(fuel, true);
        token.mint(address(wallet), 100e6);

        HypeFuel.Order memory first = _order(10e6, 0);
        first.user = address(wallet);

        HypeFuel.Order memory second = first;
        second.salt = keccak256("reentrant");
        wallet.arm(second);

        vm.expectRevert();
        vm.prank(relayer);
        fuel.fill(first, hex"");

        assertEq(token.balanceOf(address(wallet)), 100e6, "no usdc moved");
        assertEq(address(wallet).balance, 0, "no hype leaked");
    }

    /// @dev Guards the above test: without re-entry the queued order fills fine, proving the
    ///      revert came from the guard rather than an invalid second order.
    function test_fill_reentrantOrderIsOtherwiseValid() public {
        ReenteringWallet wallet = new ReenteringWallet(fuel, false);
        token.mint(address(wallet), 100e6);

        HypeFuel.Order memory order = _order(10e6, 0);
        order.user = address(wallet);
        order.salt = keccak256("reentrant");

        vm.prank(relayer);
        fuel.fill(order, hex"");

        assertEq(address(wallet).balance, _expectedHypeOut(10e6, PRICE_1E8), "valid in isolation");
    }

    /// @dev If HYPE delivery fails the whole fill must revert, never keeping the USDC.
    function test_fill_revertsWhenRecipientRejectsHype() public {
        RejectingWallet wallet = new RejectingWallet();
        token.mint(address(wallet), 100e6);

        HypeFuel.Order memory order = _order(10e6, 0);
        order.user = address(wallet);

        vm.expectRevert();
        vm.prank(relayer);
        fuel.fill(order, hex"");

        assertEq(token.balanceOf(address(wallet)), 100e6, "usdc untouched");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_fill_conservesValue(uint256 usdcIn, uint256 priceUsd1e8) public {
        usdcIn = bound(usdcIn, MIN_ORDER_USDC, MAX_ORDER_USDC);
        // $1 to $10,000 per HYPE.
        uint256 effectivePrice = _setPrice(bound(priceUsd1e8, 1e8, 10_000e8));

        token.mint(user, MAX_ORDER_USDC);
        vm.deal(address(fuel), 1_000_000 ether);

        HypeFuel.Order memory order = _order(usdcIn, 0);
        bytes memory signature = _sign(order, userPk);
        uint256 userUsdcBefore = token.balanceOf(user);
        uint256 fee = fuel.feeFor(usdcIn);

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        assertEq(userUsdcBefore - token.balanceOf(user), usdcIn, "exact usdc taken");
        assertEq(user.balance, hypeOut, "exact hype delivered");
        // We must never hand out more value than we took in, net of the fee.
        assertLe((hypeOut * effectivePrice) / 1e20, usdcIn - fee, "protocol keeps the fee");
        assertGe(fee, MIN_FEE_USDC, "fee floor respected");
    }

    function testFuzz_feeIsMonotonicAndBounded(uint256 usdcIn) public view {
        usdcIn = bound(usdcIn, 0, MAX_ORDER_USDC);
        uint256 fee = fuel.feeFor(usdcIn);

        assertGe(fee, MIN_FEE_USDC, "never below the floor");
        uint256 cap = (usdcIn * fuel.MAX_FEE_BPS()) / 10_000;
        assertLe(fee, cap > MIN_FEE_USDC ? cap : MIN_FEE_USDC, "never above the cap");
    }

    function testFuzz_orderNonceIsInjective(uint256 minHypeOutA, uint256 minHypeOutB) public view {
        vm.assume(minHypeOutA != minHypeOutB);

        HypeFuel.Order memory a = _order(10e6, minHypeOutA);
        HypeFuel.Order memory b = _order(10e6, minHypeOutB);

        assertTrue(fuel.orderNonce(a) != fuel.orderNonce(b), "distinct orders, distinct nonces");
    }
}
