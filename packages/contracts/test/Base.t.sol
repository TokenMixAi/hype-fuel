// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HypeFuel} from "../src/HypeFuel.sol";
import {IEIP3009} from "../src/interfaces/IEIP3009.sol";

/// @notice Shared fixtures and signing helpers for HypeFuel tests.
abstract contract BaseTest is Test {
    address internal constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address internal constant SPOT_PX_PRECOMPILE = 0x0000000000000000000000000000000000000808;

    uint32 internal constant HYPE_PERP_INDEX = 159;
    uint64 internal constant HYPE_SPOT_INDEX = 107;

    /// @dev Multipliers taking each precompile's raw value up to a 1e8-scaled USD price.
    uint256 internal constant ORACLE_PX_TO_1E8 = 1e4;
    uint256 internal constant SPOT_PX_TO_1E8 = 1e2;

    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @dev Restated here rather than read from the contract so signing helpers stay free of
    /// external calls, which would otherwise swallow `vm.prank` / `vm.expectRevert`.
    /// `test_orderNonce_matchesContract` asserts the two agree.
    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "HypeFuelOrder(address user,uint256 usdcIn,uint256 minHypeOut,uint256 validAfter,uint256 validBefore,bytes32 salt)"
    );

    uint256 internal constant FEE_BPS = 300;
    uint256 internal constant MIN_FEE_USDC = 0.15e6;
    uint256 internal constant MIN_ORDER_USDC = 1e6;
    uint256 internal constant MAX_ORDER_USDC = 50e6;
    uint256 internal constant MAX_DEVIATION_BPS = 500;

    /// @dev $55.147, the live HYPE price observed while building this.
    uint256 internal constant PRICE_1E8 = 5_514_700_000;

    HypeFuel internal fuel;
    address internal usdc;

    /// @dev Cached in setUp so `_sign` makes no external calls.
    bytes32 internal domainSeparator;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    uint256 internal userPk;
    address internal user;

    /// @dev Points both HYPE feeds at the same USD price, expressed at 1e8 scale.
    /// @return The price the contract will actually read back.
    function _setPrice(uint256 priceUsd1e8) internal returns (uint256) {
        return _setPrices(priceUsd1e8, priceUsd1e8);
    }

    /// @dev Sets the perp oracle and spot feeds independently to exercise the deviation guard.
    /// @return The price the contract will read, i.e. the higher of the two feeds after
    ///         rounding to what each precompile's scale can represent.
    function _setPrices(uint256 oracleUsd1e8, uint256 spotUsd1e8) internal returns (uint256) {
        // `oraclePx` is 1e4-scaled and `spotPx` 1e6-scaled for HYPE (szDecimals 2), so both
        // are coarser than our 1e8 internal scale and cannot represent every input exactly.
        uint64 oracleRaw = uint64(oracleUsd1e8 / ORACLE_PX_TO_1E8);
        uint64 spotRaw = uint64(spotUsd1e8 / SPOT_PX_TO_1E8);

        _mockPrecompile(ORACLE_PX_PRECOMPILE, abi.encode(HYPE_PERP_INDEX), oracleRaw);
        _mockPrecompile(SPOT_PX_PRECOMPILE, abi.encode(HYPE_SPOT_INDEX), spotRaw);

        uint256 oracleEffective = uint256(oracleRaw) * ORACLE_PX_TO_1E8;
        uint256 spotEffective = uint256(spotRaw) * SPOT_PX_TO_1E8;
        return oracleEffective > spotEffective ? oracleEffective : spotEffective;
    }

    function _mockPrecompile(address precompile, bytes memory callData, uint64 value) internal {
        // Precompiles are node-level and carry no bytecode, so give them a body to call into.
        if (precompile.code.length == 0) vm.etch(precompile, hex"00");
        vm.mockCall(precompile, callData, abi.encode(value));
    }

    function _order(uint256 usdcIn, uint256 minHypeOut) internal view returns (HypeFuel.Order memory) {
        return HypeFuel.Order({
            user: user,
            usdcIn: usdcIn,
            minHypeOut: minHypeOut,
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 300,
            salt: keccak256("salt")
        });
    }

    /// @dev The order commitment nonce, computed locally. Mirrors `HypeFuel.orderNonce`.
    function _orderNonce(HypeFuel.Order memory order) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.user,
                order.usdcIn,
                order.minHypeOut,
                order.validAfter,
                order.validBefore,
                order.salt
            )
        );
    }

    /// @dev Produces an EIP-3009 signature whose nonce commits to `order`.
    function _sign(HypeFuel.Order memory order, uint256 privateKey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                order.user,
                address(fuel),
                order.usdcIn,
                order.validAfter,
                order.validBefore,
                _orderNonce(order)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Expected HYPE out, computed independently of the contract.
    function _expectedHypeOut(uint256 usdcIn, uint256 priceUsd1e8) internal pure returns (uint256) {
        uint256 percentageFee = (usdcIn * FEE_BPS) / 10_000;
        uint256 fee = percentageFee < MIN_FEE_USDC ? MIN_FEE_USDC : percentageFee;
        return ((usdcIn - fee) * 1e20) / priceUsd1e8;
    }
}
