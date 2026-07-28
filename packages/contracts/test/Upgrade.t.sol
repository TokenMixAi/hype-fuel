// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockV3Pool} from "./mocks/MockV3Pool.sol";
import {MockWHYPE} from "./mocks/MockWHYPE.sol";
import {HypeFuelV2, NotUUPS} from "./mocks/HypeFuelV2.sol";
import {CallContextChecker} from "solady/utils/CallContextChecker.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {UUPSUpgradeable} from "solady/utils/UUPSUpgradeable.sol";

/// @notice Proxy and upgrade behaviour.
///
/// @dev The point of upgradeability here is that the address never has to change again, so
///      these tests are mostly about the ways an upgrade could go wrong: losing state,
///      being performed by the wrong account, or leaving the proxy re-initializable.
contract UpgradeTest is BaseTest {
    MockUSDC internal token;

    function setUp() public {
        token = new MockUSDC();
        usdc = address(token);
        (user, userPk) = makeAddrAndKey("user");

        fuel = _deployFuel();
        domainSeparator = token.DOMAIN_SEPARATOR();

        _setPrice(PRICE_1E8);
        vm.deal(address(fuel), 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_init_appliesConstructorArguments() public view {
        assertEq(address(fuel.usdc()), usdc, "usdc");
        assertEq(fuel.owner(), owner, "owner");
        assertEq(fuel.feeBps(), FEE_BPS, "feeBps");
        assertEq(fuel.minFeeUsdc(), MIN_FEE_USDC, "minFeeUsdc");
        assertEq(fuel.minOrderUsdc(), MIN_ORDER_USDC, "minOrderUsdc");
        assertEq(fuel.maxOrderUsdc(), MAX_ORDER_USDC, "maxOrderUsdc");
        assertEq(fuel.maxOracleDeviationBps(), MAX_DEVIATION_BPS, "maxOracleDeviationBps");
    }

    function test_init_proxyCannotBeReinitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        fuel.initialize(
            makeAddr("attacker"), usdc, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_DEVIATION_BPS
        );
    }

    /// @dev A live implementation left initializable is the classic UUPS foot-gun, so the
    ///      constructor burns the initializer on the implementation itself.
    function test_init_implementationCannotBeInitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        HypeFuel(payable(implementation))
            .initialize(
                makeAddr("attacker"), usdc, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_DEVIATION_BPS
            );
    }

    /// @dev The implementation's initializer is burned, so the guard is only reachable through
    ///      a proxy -- which is also the only way it matters.
    function test_init_rejectsZeroAddresses() public {
        vm.expectRevert(HypeFuel.ZeroAddress.selector);
        new ERC1967Proxy(implementation, _initData(address(0), usdc));

        vm.expectRevert(HypeFuel.ZeroAddress.selector);
        new ERC1967Proxy(implementation, _initData(owner, address(0)));
    }

    function _initData(address owner_, address usdc_) internal pure returns (bytes memory) {
        return abi.encodeCall(
            HypeFuel.initialize,
            (owner_, usdc_, FEE_BPS, MIN_FEE_USDC, MIN_ORDER_USDC, MAX_ORDER_USDC, MAX_DEVIATION_BPS)
        );
    }

    /*//////////////////////////////////////////////////////////////
                                UPGRADES
    //////////////////////////////////////////////////////////////*/

    function test_upgrade_preservesStateAndFunds() public {
        vm.prank(owner);
        fuel.setFee(123, 0.2e6);
        token.mint(address(fuel), 500e6);

        uint256 hypeBefore = address(fuel).balance;

        address v2 = address(new HypeFuelV2());
        vm.prank(owner);
        fuel.upgradeToAndCall(v2, "");

        assertEq(HypeFuelV2(payable(address(fuel))).version(), 2, "new logic live");
        assertEq(fuel.feeBps(), 123, "feeBps survived");
        assertEq(fuel.minFeeUsdc(), 0.2e6, "minFeeUsdc survived");
        assertEq(address(fuel.usdc()), usdc, "usdc survived");
        assertEq(fuel.owner(), owner, "owner survived");
        assertEq(address(fuel).balance, hypeBefore, "hype inventory survived");
        assertEq(token.balanceOf(address(fuel)), 500e6, "usdc survived");
    }

    /// @notice Rebalance configuration must survive an upgrade, and still work afterwards.
    ///
    /// @dev The other state test predates rebalancing and only covers the fee and balance slots.
    ///      These fields were appended later, which makes them exactly the ones a botched upgrade
    ///      would silently lose. Asserting the values is not enough on its own either: a pool
    ///      address that reads back correctly but no longer swaps is still a broken upgrade, so this
    ///      finishes by rebalancing through the new implementation.
    function test_upgrade_preservesRebalanceConfigAndStillRebalances() public {
        vm.etch(WHYPE, address(new MockWHYPE()).code);
        MockV3Pool pool = new MockV3Pool(WHYPE, usdc);
        pool.setPrice(PRICE_1E8);

        vm.startPrank(owner);
        fuel.setPool(address(pool));
        fuel.setRebalanceConfig(HYPE_TARGET, HYPE_FLOOR, MIN_REBALANCE_USDC, REBALANCE_SLIPPAGE_BPS);
        vm.stopPrank();

        // Stock the pool, then draw inventory below the floor so a rebalance is warranted.
        vm.deal(address(this), address(this).balance + 10_000 ether);
        MockWHYPE(payable(WHYPE)).deposit{value: 10_000 ether}();
        MockWHYPE(payable(WHYPE)).transfer(address(pool), 10_000 ether);
        vm.deal(address(fuel), 5 ether);
        token.mint(address(fuel), 2_000e6);

        uint256 pendingBefore = fuel.pendingRebalanceUsdc();
        assertGt(pendingBefore, 0, "a rebalance should be warranted before upgrading");

        // Deployed before the prank, so the constructor does not consume it.
        address v2 = address(new HypeFuelV2());
        vm.prank(owner);
        fuel.upgradeToAndCall(v2, "");

        (
            address poolAfter,
            bool usdcIsToken0After,
            uint256 targetAfter,
            uint256 floorAfter,
            uint256 minRebalanceAfter,
            uint256 slippageAfter,
        ) = fuel.rebalanceConfig();

        assertEq(poolAfter, address(pool), "pool survived");
        // Derived by setPool rather than passed in, so an upgrade that lost it would silently swap
        // in the wrong direction rather than revert.
        assertFalse(usdcIsToken0After, "token ordering survived");
        assertEq(targetAfter, HYPE_TARGET, "hypeTarget survived");
        assertEq(floorAfter, HYPE_FLOOR, "hypeFloor survived");
        assertEq(minRebalanceAfter, MIN_REBALANCE_USDC, "minRebalanceUsdc survived");
        assertEq(slippageAfter, REBALANCE_SLIPPAGE_BPS, "maxRebalanceSlippageBps survived");
        assertEq(fuel.pendingRebalanceUsdc(), pendingBefore, "same work outstanding after upgrade");

        uint256 hypeBefore = address(fuel).balance;
        (uint256 usdcIn, uint256 hypeOut) = fuel.rebalance();

        assertEq(usdcIn, pendingBefore, "spent what it said it would");
        assertGt(hypeOut, 0, "bought HYPE through the upgraded implementation");
        assertEq(address(fuel).balance, hypeBefore + hypeOut, "inventory grew by the amount bought");
    }

    /// @dev Appending state must not disturb what came before it.
    function test_upgrade_appendedStorageDoesNotCollide() public {
        address next = address(new HypeFuelV2());

        vm.prank(owner);
        fuel.setOrderLimits(2e6, 40e6);

        vm.prank(owner);
        fuel.upgradeToAndCall(next, "");

        HypeFuelV2 v2 = HypeFuelV2(payable(address(fuel)));
        vm.prank(owner);
        v2.setAppendedValue(999);

        assertEq(v2.appendedValue(), 999, "new slot written");
        assertEq(fuel.minOrderUsdc(), 2e6, "existing slot intact");
        assertEq(fuel.maxOrderUsdc(), 40e6, "existing slot intact");
        assertEq(fuel.maxOracleDeviationBps(), MAX_DEVIATION_BPS, "existing slot intact");
    }

    function test_upgrade_onlyOwner() public {
        address v2 = address(new HypeFuelV2());

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Ownable.Unauthorized.selector);
        fuel.upgradeToAndCall(v2, "");
    }

    function test_upgrade_rejectsNonUupsImplementation() public {
        address bad = address(new NotUUPS());

        vm.prank(owner);
        vm.expectRevert(UUPSUpgradeable.UpgradeFailed.selector);
        fuel.upgradeToAndCall(bad, "");
    }

    /// @dev Even if someone gained ownership of the bare implementation, `onlyProxy` stops
    ///      them from driving an upgrade through it.
    function test_upgrade_cannotBeCalledOnImplementationDirectly() public {
        address next = address(new HypeFuelV2());

        vm.expectRevert(CallContextChecker.UnauthorizedCallContext.selector);
        HypeFuel(payable(implementation)).upgradeToAndCall(next, "");
    }

    /// @dev Fills must keep working across an upgrade, using the same signature scheme.
    function test_upgrade_fillStillWorksAfterwards() public {
        address next = address(new HypeFuelV2());
        token.mint(user, 1_000e6);

        vm.prank(owner);
        fuel.upgradeToAndCall(next, "");

        HypeFuel.Order memory order = _order(10e6, 0);
        bytes memory signature = _sign(order, userPk);

        vm.prank(relayer);
        uint256 hypeOut = fuel.fill(order, signature);

        assertEq(hypeOut, _expectedHypeOut(10e6, PRICE_1E8), "fill unchanged by the upgrade");
    }
}
