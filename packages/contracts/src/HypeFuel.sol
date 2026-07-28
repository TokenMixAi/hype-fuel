// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";

import {IEIP3009} from "./interfaces/IEIP3009.sol";

/// @title HypeFuel
/// @notice Sells native HYPE for USDC to wallets that hold stablecoins but no gas.
///
/// The user never sends a transaction. They sign a single EIP-3009
/// `ReceiveWithAuthorization` message over their USDC; any third party can then submit
/// it here. This contract pulls the USDC, prices HYPE from HyperCore's oracle
/// precompiles, and forwards native HYPE to the signer in the same transaction.
///
/// @dev Binding the full order to one signature:
/// EIP-3009 signs over `(from, to, value, validAfter, validBefore, nonce)`, which leaves
/// no field for order data such as `minHypeOut`. Instead the `nonce` is *derived* as a
/// hash of the order (see {orderNonce}). Because the token verifies the signature over
/// that nonce, altering any order field changes the nonce and invalidates the signature.
/// One signature therefore commits to the entire order, and the token's own
/// `authorizationState` mapping provides replay protection.
contract HypeFuel is Ownable, ReentrancyGuard {
    using SafeTransferLib for address;

    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @param user     Signer of the authorization. Pays the USDC and receives the HYPE.
    /// @param usdcIn   USDC to spend, 6 decimals.
    /// @param minHypeOut Minimum acceptable HYPE (18 decimals); protects the signer
    ///                   against price movement between signing and execution.
    /// @param validAfter Unix timestamp the authorization becomes valid *after*.
    /// @param validBefore Unix timestamp the authorization becomes invalid *at*.
    /// @param salt     Random value making otherwise-identical orders distinct, since the
    ///                 derived nonce is single-use.
    struct Order {
        address user;
        uint256 usdcIn;
        uint256 minHypeOut;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
    }

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS = 10_000;

    /// @notice Domain tag for the order commitment. Mirrored by the TypeScript SDK.
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "HypeFuelOrder(address user,uint256 usdcIn,uint256 minHypeOut,uint256 validAfter,uint256 validBefore,bytes32 salt)"
    );

    /// @notice HyperCore perp index for HYPE, source of the manipulation-resistant oracle price.
    uint32 public constant HYPE_PERP_INDEX = 159;

    /// @notice HyperCore spot market index for HYPE/USDC, used as a cross-check.
    uint64 public constant HYPE_SPOT_INDEX = 107;

    /// @dev `oraclePx` is scaled by `10**(6 - szDecimals)`. HYPE has szDecimals 2, so the
    ///      raw value is 1e4-scaled and needs 1e4 to reach our internal 1e8 scale.
    uint256 internal constant ORACLE_PX_TO_1E8 = 1e4;

    /// @dev `spotPx` is scaled by `10**(8 - szDecimals)`, i.e. 1e6-scaled for HYPE.
    uint256 internal constant SPOT_PX_TO_1E8 = 1e2;

    /// @dev Converts 6-decimal USDC into 18-decimal HYPE at a 1e8-scaled USD price:
    ///      1e12 to bridge the decimals, 1e8 to undo the price scale.
    uint256 internal constant USDC_TO_HYPE_SCALE = 1e20;

    /// @notice Hard ceiling on the percentage fee, fixed at deployment.
    /// @dev Lets a signer bound their worst case: governance can never raise the fee past this.
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Hard ceiling on the flat minimum fee ($1.00), fixed at deployment.
    uint256 public constant MAX_MIN_FEE_USDC = 1e6;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The EIP-3009 stablecoin accepted as payment (native USDC, 6 decimals).
    IEIP3009 public immutable USDC;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Percentage fee in basis points.
    uint256 public feeBps;

    /// @notice Floor on the fee, in USDC. Covers fixed per-fill costs on dust orders.
    uint256 public minFeeUsdc;

    /// @notice Smallest accepted order, in USDC.
    uint256 public minOrderUsdc;

    /// @notice Largest accepted order, in USDC. Caps inventory and oracle risk per fill.
    uint256 public maxOrderUsdc;

    /// @notice Maximum tolerated divergence between the perp oracle and spot price.
    /// @dev Forces a would-be manipulator to move both feeds at once.
    uint256 public maxOracleDeviationBps;

    /// @notice When true, {fill} is disabled. Withdrawals remain available.
    bool public paused;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Filled(
        address indexed user,
        address indexed relayer,
        uint256 usdcIn,
        uint256 feeUsdc,
        uint256 hypeOut,
        uint256 priceUsd1e8,
        bytes32 nonce
    );
    event FeeUpdated(uint256 feeBps, uint256 minFeeUsdc);
    event OrderLimitsUpdated(uint256 minOrderUsdc, uint256 maxOrderUsdc);
    event MaxOracleDeviationUpdated(uint256 maxOracleDeviationBps);
    event PausedSet(bool paused);
    event HypeDeposited(address indexed from, uint256 amount);
    event HypeWithdrawn(address indexed to, uint256 amount);
    event UsdcWithdrawn(address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error Paused();
    error OrderSizeOutOfRange(uint256 usdcIn, uint256 min, uint256 max);
    error OrderNotYetValid(uint256 validAfter);
    error OrderExpired(uint256 validBefore);
    error InsufficientOutput(uint256 hypeOut, uint256 minHypeOut);
    error InsufficientLiquidity(uint256 hypeOut, uint256 available);
    error OracleUnavailable();
    error OracleDeviation(uint256 oraclePrice, uint256 spotPrice);
    error FeeExceedsAmount();
    error InvalidFee();
    error InvalidOrderLimits();
    error InvalidDeviation();
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address owner_,
        address usdc_,
        uint256 feeBps_,
        uint256 minFeeUsdc_,
        uint256 minOrderUsdc_,
        uint256 maxOrderUsdc_,
        uint256 maxOracleDeviationBps_
    ) {
        if (owner_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        _initializeOwner(owner_);
        USDC = IEIP3009(usdc_);
        _setFee(feeBps_, minFeeUsdc_);
        _setOrderLimits(minOrderUsdc_, maxOrderUsdc_);
        _setMaxOracleDeviationBps(maxOracleDeviationBps_);
    }

    /*//////////////////////////////////////////////////////////////
                                PRICING
    //////////////////////////////////////////////////////////////*/

    /// @notice Current HYPE price in USD, scaled by 1e8.
    /// @dev Reads both the perp oracle and the spot market. Reverts if they diverge beyond
    ///      {maxOracleDeviationBps}, then prices at the higher of the two so that
    ///      pushing either feed down cannot extract extra HYPE.
    function hypePriceUsd1e8() public view returns (uint256) {
        uint256 oraclePrice = uint256(PrecompileLib.oraclePx(HYPE_PERP_INDEX)) * ORACLE_PX_TO_1E8;
        uint256 spotPrice = uint256(PrecompileLib.spotPx(HYPE_SPOT_INDEX)) * SPOT_PX_TO_1E8;
        if (oraclePrice == 0 || spotPrice == 0) revert OracleUnavailable();

        (uint256 low, uint256 high) = oraclePrice < spotPrice ? (oraclePrice, spotPrice) : (spotPrice, oraclePrice);
        if ((high - low) * BPS > low * maxOracleDeviationBps) {
            revert OracleDeviation(oraclePrice, spotPrice);
        }
        return high;
    }

    /// @notice Fee charged on `usdcIn`: a percentage, floored at {minFeeUsdc}.
    function feeFor(uint256 usdcIn) public view returns (uint256) {
        uint256 percentageFee = (usdcIn * feeBps) / BPS;
        return percentageFee < minFeeUsdc ? minFeeUsdc : percentageFee;
    }

    /// @notice Preview a fill at the current price.
    /// @return hypeOut HYPE the signer would receive, 18 decimals.
    /// @return feeUsdc Fee retained by the protocol, 6 decimals.
    /// @return priceUsd1e8 Price used for the conversion.
    function quote(uint256 usdcIn) public view returns (uint256 hypeOut, uint256 feeUsdc, uint256 priceUsd1e8) {
        priceUsd1e8 = hypePriceUsd1e8();
        feeUsdc = feeFor(usdcIn);
        if (feeUsdc >= usdcIn) revert FeeExceedsAmount();
        hypeOut = ((usdcIn - feeUsdc) * USDC_TO_HYPE_SCALE) / priceUsd1e8;
    }

    /*//////////////////////////////////////////////////////////////
                                 ORDERS
    //////////////////////////////////////////////////////////////*/

    /// @notice The EIP-3009 nonce for an order: a commitment to every order field.
    /// @dev Must match `orderNonce` in the TypeScript SDK byte for byte.
    function orderNonce(Order calldata order) public pure returns (bytes32) {
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

    /// @notice True once an order's authorization has been used or cancelled.
    function isOrderUsed(Order calldata order) external view returns (bool) {
        return USDC.authorizationState(order.user, orderNonce(order));
    }

    /// @notice Execute a signed order: pull USDC from the signer, send them HYPE.
    /// @dev Permissionless. Every fill is profitable for the contract by construction, so
    ///      anyone may relay one; that removes us as a liveness bottleneck.
    /// @param order The order committed to by `signature`.
    /// @param signature EIP-3009 `ReceiveWithAuthorization` signature. Raw 65-byte ECDSA or
    ///        an ERC-1271 signature from a smart-contract wallet.
    /// @return hypeOut HYPE delivered to `order.user`.
    function fill(Order calldata order, bytes calldata signature) external nonReentrant returns (uint256 hypeOut) {
        if (paused) revert Paused();
        if (order.usdcIn < minOrderUsdc || order.usdcIn > maxOrderUsdc) {
            revert OrderSizeOutOfRange(order.usdcIn, minOrderUsdc, maxOrderUsdc);
        }
        // Mirrors the token's own window checks, but fails earlier with a precise reason.
        if (block.timestamp <= order.validAfter) revert OrderNotYetValid(order.validAfter);
        if (block.timestamp >= order.validBefore) revert OrderExpired(order.validBefore);

        uint256 feeUsdc;
        uint256 priceUsd1e8;
        (hypeOut, feeUsdc, priceUsd1e8) = quote(order.usdcIn);

        if (hypeOut < order.minHypeOut) revert InsufficientOutput(hypeOut, order.minHypeOut);
        if (address(this).balance < hypeOut) {
            revert InsufficientLiquidity(hypeOut, address(this).balance);
        }

        bytes32 nonce = orderNonce(order);

        // Verifies the signature and moves the USDC. Reverts unless `signature` covers
        // exactly this order, and unless this nonce is unused. `to` is forced to
        // address(this) and the token requires msg.sender == to, so a signed order can
        // only ever be spent here.
        USDC.receiveWithAuthorization(
            order.user, address(this), order.usdcIn, order.validAfter, order.validBefore, nonce, signature
        );

        // Funds move only after the pull succeeds, and the guard blocks re-entry.
        order.user.safeTransferETH(hypeOut);

        emit Filled(order.user, msg.sender, order.usdcIn, feeUsdc, hypeOut, priceUsd1e8, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice HYPE inventory available to fill orders.
    function availableHype() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Everything a client needs to build and price an order, in one call.
    function config()
        external
        view
        returns (
            address usdc,
            uint256 feeBps_,
            uint256 minFeeUsdc_,
            uint256 minOrderUsdc_,
            uint256 maxOrderUsdc_,
            uint256 maxOracleDeviationBps_,
            uint256 maxFeeBps,
            bool paused_,
            uint256 hypeBalance
        )
    {
        return (
            address(USDC),
            feeBps,
            minFeeUsdc,
            minOrderUsdc,
            maxOrderUsdc,
            maxOracleDeviationBps,
            MAX_FEE_BPS,
            paused,
            address(this).balance
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function setFee(uint256 feeBps_, uint256 minFeeUsdc_) external onlyOwner {
        _setFee(feeBps_, minFeeUsdc_);
    }

    function setOrderLimits(uint256 minOrderUsdc_, uint256 maxOrderUsdc_) external onlyOwner {
        _setOrderLimits(minOrderUsdc_, maxOrderUsdc_);
    }

    function setMaxOracleDeviationBps(uint256 maxOracleDeviationBps_) external onlyOwner {
        _setMaxOracleDeviationBps(maxOracleDeviationBps_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdrawHype(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        to.safeTransferETH(amount);
        emit HypeWithdrawn(to, amount);
    }

    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        address(USDC).safeTransfer(to, amount);
        emit UsdcWithdrawn(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _setFee(uint256 feeBps_, uint256 minFeeUsdc_) internal {
        if (feeBps_ > MAX_FEE_BPS || minFeeUsdc_ > MAX_MIN_FEE_USDC) revert InvalidFee();
        feeBps = feeBps_;
        minFeeUsdc = minFeeUsdc_;
        emit FeeUpdated(feeBps_, minFeeUsdc_);
    }

    function _setOrderLimits(uint256 minOrderUsdc_, uint256 maxOrderUsdc_) internal {
        // A minimum at or below the flat fee would allow zero-output fills.
        if (minOrderUsdc_ > maxOrderUsdc_ || minOrderUsdc_ <= minFeeUsdc) revert InvalidOrderLimits();
        minOrderUsdc = minOrderUsdc_;
        maxOrderUsdc = maxOrderUsdc_;
        emit OrderLimitsUpdated(minOrderUsdc_, maxOrderUsdc_);
    }

    function _setMaxOracleDeviationBps(uint256 maxOracleDeviationBps_) internal {
        if (maxOracleDeviationBps_ == 0 || maxOracleDeviationBps_ > BPS) revert InvalidDeviation();
        maxOracleDeviationBps = maxOracleDeviationBps_;
        emit MaxOracleDeviationUpdated(maxOracleDeviationBps_);
    }

    /// @notice Accepts HYPE inventory.
    receive() external payable {
        emit HypeDeposited(msg.sender, msg.value);
    }
}
