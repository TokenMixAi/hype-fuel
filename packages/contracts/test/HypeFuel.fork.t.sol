// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./Base.t.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {IEIP3009} from "../src/interfaces/IEIP3009.sol";
import {PrecompileSimulator} from "@hyper-evm-lib/test/utils/PrecompileSimulator.sol";

/// @notice Fork tests against the real native USDC on HyperEVM.
///
/// The hermetic suite runs against `MockUSDC`; these tests exist to prove that mock is
/// faithful. Every assertion here exercises Circle's actual FiatTokenV2_2 deployment, so a
/// divergence between the mock and mainnet shows up as a failure.
contract HypeFuelForkTest is BaseTest {
    /// @dev Circle's native USDC on HyperEVM.
    address internal constant NATIVE_USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;

    function setUp() public {
        vm.createSelectFork("hyperevm");

        usdc = NATIVE_USDC;
        (user, userPk) = makeAddrAndKey("forkUser");

        fuel = _deployFuel();
        domainSeparator = IEIP3009(usdc).DOMAIN_SEPARATOR();

        deal(usdc, user, 1_000e6);
        vm.deal(address(fuel), 100 ether);
    }

    /// @dev Sanity check that we are talking to the real token.
    function test_fork_usdcIsTheRealToken() public view {
        assertEq(IEIP3009(usdc).decimals(), 6, "6 decimals");
        assertEq(IEIP3009(usdc).balanceOf(user), 1_000e6, "test balance funded");
        assertEq(
            domainSeparator,
            0x70a72998ad787d1a9152a8f88ccfe0766b1cb293b6b4011b34523035da10b0a3,
            "mainnet USDC domain separator"
        );
    }

    /// @dev The full flow against Circle's contract: one signature moves real USDC and
    ///      delivers native HYPE.
    function test_fork_fillAgainstRealUsdc() public {
        _setPrice(PRICE_1E8);

        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);
        uint256 expectedHype = _expectedHypeOut(10e6, PRICE_1E8);

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        assertEq(hypeOut, expectedHype, "hype out matches the hermetic suite");
        assertEq(user.balance, expectedHype, "user received hype");
        assertEq(IEIP3009(usdc).balanceOf(user), 990e6, "real usdc debited");
        assertEq(IEIP3009(usdc).balanceOf(address(fuel)), 10e6, "contract holds the usdc");
    }

    /// @dev The commitment trick, verified by the real token rather than our mock.
    function test_fork_realUsdcRejectsTamperedMinHypeOut() public {
        _setPrice(PRICE_1E8);

        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        order.minHypeOut = 1;

        vm.expectRevert("FiatTokenV2: invalid signature");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    /// @dev Real USDC must enforce single use of the derived nonce.
    function test_fork_realUsdcRejectsReplay() public {
        _setPrice(PRICE_1E8);

        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(relayer);
        fuel.fill(order, signature);

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        vm.prank(relayer);
        fuel.fill(order, signature);
    }

    /// @dev Reads the live HyperCore precompiles rather than mocks, confirming the index
    ///      constants and decimal scaling are right against production data.
    function test_fork_liveOracleReturnsSanePrice() public {
        PrecompileSimulator.init();

        uint256 price = fuel.hypePriceUsd1e8();

        // Deliberately wide: this asserts the scaling is correct, not any particular price.
        assertGt(price, 1e8, "HYPE above $1");
        assertLt(price, 10_000e8, "HYPE below $10,000");

        emit log_named_decimal_uint("live HYPE price (USD)", price, 8);
    }

    /// @dev End-to-end against both the real token and the real oracle.
    ///
    /// @dev The price comes from the `Filled` event rather than a separate `hypePriceUsd1e8`
    ///      call. The precompiles resolve against the live chain, so two reads can straddle a
    ///      real price tick; comparing against a separately-read price failed intermittently
    ///      for that reason alone. Taking the price the contract actually used keeps this an
    ///      exact assertion about live pricing without racing the market.
    function test_fork_fillAtLiveOraclePrice() public {
        PrecompileSimulator.init();

        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.recordLogs();
        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        uint256 priceUsed = _filledPrice();

        assertEq(hypeOut, _expectedHypeOut(10e6, priceUsed), "priced at the live oracle");
        assertGt(priceUsed, 1e8, "live price above $1");
        assertLt(priceUsed, 10_000e8, "live price below $10,000");

        emit log_named_decimal_uint("live HYPE price (USD)", priceUsed, 8);
        emit log_named_decimal_uint("HYPE delivered for $10", hypeOut, 18);
    }

    /// @dev Pulls `priceUsd1e8` out of the `Filled` event emitted by the last call.
    function _filledPrice() internal view returns (uint256) {
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(fuel) && logs[i].topics[0] == HypeFuel.Filled.selector) {
                (,,, uint256 priceUsd1e8,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, bytes32));
                return priceUsd1e8;
            }
        }

        revert("no Filled event");
    }
}
