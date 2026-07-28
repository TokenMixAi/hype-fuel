// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/auth/Ownable.sol";
import {Initializable} from "solady/utils/Initializable.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeCastLib} from "solady/utils/SafeCastLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {UUPSUpgradeable} from "solady/utils/UUPSUpgradeable.sol";
import {PrecompileLib} from "@hyper-evm-lib/src/PrecompileLib.sol";

import {IEIP3009} from "./interfaces/IEIP3009.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {IWHYPE} from "./interfaces/IWHYPE.sol";

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
///
/// @dev Inventory: every fill takes in USDC and pays out HYPE, so sustained operation
/// drains HYPE and accumulates USDC. {rebalance} closes that loop on-chain, recycling the
/// accumulated USDC back into HYPE inventory. It is permissionless for the same reason
/// {fill} is: the party who most wants inventory to exist is the next user.
///
/// @dev Upgradeable via UUPS behind an ERC-1967 proxy. Storage layout is append-only;
/// see the STORAGE section.
contract HypeFuel is Initializable, Ownable, ReentrancyGuard, UUPSUpgradeable {
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

    /// @notice Ceiling on the percentage fee.
    /// @dev Bounds the fee within this implementation. An upgrade could lift it, so a signer's
    ///      real protection is the `minHypeOut` their signature commits to.
    uint256 public constant MAX_FEE_BPS = 500;

    /// @notice Ceiling on the flat minimum fee ($1.00).
    uint256 public constant MAX_MIN_FEE_USDC = 1e6;

    /// @notice Ceiling on {maxRebalanceSlippageBps}.
    /// @dev Deliberately tight. A rebalance is never urgent, so it should fail closed rather
    ///      than execute at a bad price; observed all-in cost on the Project X pool is
    ///      5-13 bps even at $50k.
    uint256 public constant MAX_REBALANCE_SLIPPAGE_BPS = 300;

    /// @notice Canonical wrapped HYPE on HyperEVM. Swap output arrives wrapped and is unwrapped
    ///         to native HYPE before it counts as inventory.
    IWHYPE public constant WHYPE = IWHYPE(0x5555555555555555555555555555555555555555);

    /// @dev Uniswap V3 price bounds. Swaps pass the extreme in their direction, because the
    ///      real execution guard is the oracle-derived {minHypeOut}, not a tick bound.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/
    // Append-only. Never reorder, retype, or remove a slot; new state goes at the end.
    // Solady's Ownable, ReentrancyGuard and UUPSUpgradeable all use fixed, collision-free
    // slots of their own, so this layout starts at slot 0 and is ours alone.

    /// @notice The EIP-3009 stablecoin accepted as payment (native USDC, 6 decimals).
    /// @dev Storage rather than an immutable so that every upgrade inherits it automatically,
    ///      instead of each new implementation having to be constructed with it correctly.
    IEIP3009 public usdc;

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

    /// @notice When true, {fill} and {rebalance} are disabled. Withdrawals remain available.
    bool public paused;

    /// @notice Uniswap V3 pool used to buy HYPE inventory. Zero disables {rebalance}.
    address public pool;

    /// @notice Whether USDC is `token0` of {pool}, cached when the pool is set.
    bool public usdcIsToken0;

    /// @notice HYPE inventory level a rebalance refills towards.
    uint256 public hypeTarget;

    /// @notice HYPE inventory level at or below which a rebalance is permitted.
    /// @dev Strictly below {hypeTarget}, giving hysteresis: one rebalance lifts the balance
    ///      clear of this floor, so the next is only possible after real depletion.
    uint256 public hypeFloor;

    /// @notice Smallest USDC amount worth swapping. Stops dust rebalances burning fees.
    uint256 public minRebalanceUsdc;

    /// @notice Tolerance between the oracle-implied HYPE output and what the pool must deliver.
    uint256 public maxRebalanceSlippageBps;

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
    event Rebalanced(address indexed caller, uint256 usdcIn, uint256 hypeOut, uint256 priceUsd1e8);
    event FeeUpdated(uint256 feeBps, uint256 minFeeUsdc);
    event OrderLimitsUpdated(uint256 minOrderUsdc, uint256 maxOrderUsdc);
    event MaxOracleDeviationUpdated(uint256 maxOracleDeviationBps);
    event PoolUpdated(address pool, bool usdcIsToken0);
    event RebalanceConfigUpdated(
        uint256 hypeTarget, uint256 hypeFloor, uint256 minRebalanceUsdc, uint256 maxRebalanceSlippageBps
    );
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
    error PoolNotSet();
    error InvalidPool();
    error InvalidRebalanceConfig();
    error RebalanceNotNeeded(uint256 hypeBalance, uint256 hypeFloor);
    error RebalanceTooSmall(uint256 usdcIn, uint256 minRebalanceUsdc);
    error UnauthorizedCallback();

    /*//////////////////////////////////////////////////////////////
                              INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Locks the implementation so it can only ever be used through a proxy.
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address usdc_,
        uint256 feeBps_,
        uint256 minFeeUsdc_,
        uint256 minOrderUsdc_,
        uint256 maxOrderUsdc_,
        uint256 maxOracleDeviationBps_
    ) external initializer {
        if (owner_ == address(0) || usdc_ == address(0)) revert ZeroAddress();
        _initializeOwner(owner_);
        usdc = IEIP3009(usdc_);
        _setFee(feeBps_, minFeeUsdc_);
        _setOrderLimits(minOrderUsdc_, maxOrderUsdc_);
        _setMaxOracleDeviationBps(maxOracleDeviationBps_);
    }

    /// @dev Makes ownership single-initialization and keeps `renounceOwnership` from
    ///      returning the slot to a re-initializable state.
    function _guardInitializeOwner() internal pure override returns (bool) {
        return true;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /*//////////////////////////////////////////////////////////////
                                PRICING
    //////////////////////////////////////////////////////////////*/

    /// @notice Current HYPE price in USD, scaled by 1e8.
    /// @dev Prices at the higher of the two feeds so that pushing either one down cannot
    ///      extract extra HYPE from a fill.
    function hypePriceUsd1e8() public view returns (uint256) {
        (, uint256 high) = _hypePrices();
        return high;
    }

    /// @dev Reads the perp oracle and the spot market, reverting if they diverge beyond
    ///      {maxOracleDeviationBps}. Callers pick whichever bound is conservative for them:
    ///      selling HYPE uses the high price, buying it uses the low one.
    function _hypePrices() internal view returns (uint256 low, uint256 high) {
        uint256 oraclePrice = uint256(PrecompileLib.oraclePx(HYPE_PERP_INDEX)) * ORACLE_PX_TO_1E8;
        uint256 spotPrice = uint256(PrecompileLib.spotPx(HYPE_SPOT_INDEX)) * SPOT_PX_TO_1E8;
        if (oraclePrice == 0 || spotPrice == 0) revert OracleUnavailable();

        (low, high) = oraclePrice < spotPrice ? (oraclePrice, spotPrice) : (spotPrice, oraclePrice);
        if ((high - low) * BPS > low * maxOracleDeviationBps) {
            revert OracleDeviation(oraclePrice, spotPrice);
        }
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
        return usdc.authorizationState(order.user, orderNonce(order));
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
        usdc.receiveWithAuthorization(
            order.user, address(this), order.usdcIn, order.validAfter, order.validBefore, nonce, signature
        );

        // Funds move only after the pull succeeds, and the guard blocks re-entry.
        order.user.safeTransferETH(hypeOut);

        emit Filled(order.user, msg.sender, order.usdcIn, feeUsdc, hypeOut, priceUsd1e8, nonce);
    }

    /*//////////////////////////////////////////////////////////////
                               REBALANCING
    //////////////////////////////////////////////////////////////*/

    /// @notice Spend accumulated USDC on HYPE, refilling inventory towards {hypeTarget}.
    ///
    /// @dev Permissionless and unrewarded. No bounty is needed because the incentive is
    ///      already aligned: anyone whose fill just failed with {InsufficientLiquidity} can
    ///      call this and then fill. Leaving out a bounty also means a caller can never
    ///      extract value by calling it repeatedly.
    ///
    /// @dev The pool price is not trusted. `minHypeOut` comes from the HyperCore feeds, which
    ///      an AMM manipulator cannot move, so a skewed pool makes this revert rather than
    ///      execute badly. It is derived from the *lower* feed, the conservative direction
    ///      when buying, so a divergence between feeds fails closed too.
    ///
    /// @return usdcIn  USDC spent.
    /// @return hypeOut Native HYPE added to inventory.
    function rebalance() external nonReentrant returns (uint256 usdcIn, uint256 hypeOut) {
        if (paused) revert Paused();
        if (pool == address(0)) revert PoolNotSet();

        (uint256 low,) = _hypePrices();

        uint256 hypeBalance = address(this).balance;
        if (hypeBalance > hypeFloor) revert RebalanceNotNeeded(hypeBalance, hypeFloor);

        usdcIn = _rebalanceAmount(hypeBalance, low);
        // The zero case also covers a contract whose rebalance config was never set.
        if (usdcIn == 0 || usdcIn < minRebalanceUsdc) revert RebalanceTooSmall(usdcIn, minRebalanceUsdc);

        uint256 minHypeOut = (usdcIn * USDC_TO_HYPE_SCALE * (BPS - maxRebalanceSlippageBps)) / (low * BPS);

        hypeOut = _buyHype(usdcIn, minHypeOut);

        emit Rebalanced(msg.sender, usdcIn, hypeOut, low);
    }

    /// @notice USDC that a {rebalance} would spend right now, or zero if it would revert.
    /// @dev Reverts if the oracle itself is unusable, since that is worth surfacing.
    function pendingRebalanceUsdc() external view returns (uint256) {
        if (paused || pool == address(0)) return 0;

        (uint256 low,) = _hypePrices();
        uint256 hypeBalance = address(this).balance;
        if (hypeBalance > hypeFloor) return 0;

        uint256 usdcIn = _rebalanceAmount(hypeBalance, low);
        return usdcIn < minRebalanceUsdc ? 0 : usdcIn;
    }

    /// @dev USDC needed to close the gap to {hypeTarget}, capped by the USDC actually held.
    function _rebalanceAmount(uint256 hypeBalance, uint256 priceUsd1e8) internal view returns (uint256) {
        uint256 deficitHype = hypeTarget - hypeBalance;
        uint256 needed = (deficitHype * priceUsd1e8) / USDC_TO_HYPE_SCALE;
        uint256 available = address(usdc).balanceOf(address(this));
        return needed < available ? needed : available;
    }

    /// @dev Sells exactly `usdcIn` into {pool} and unwraps the proceeds to native HYPE.
    function _buyHype(uint256 usdcIn, uint256 minHypeOut) internal returns (uint256 hypeOut) {
        bool zeroForOne = usdcIsToken0;

        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool)
            .swap(
                address(this),
                zeroForOne,
                SafeCastLib.toInt256(usdcIn),
                // The oracle bound is the real guard, so let the swap run to the tick extreme.
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            );

        // The HYPE leg is whichever side the pool paid out, so its delta is negative. The safe
        // cast turns a pool that reports otherwise into a revert rather than a huge amount.
        hypeOut = SafeCastLib.toUint256(-(zeroForOne ? amount1 : amount0));

        // A swap that consumed less than `usdcIn` also delivered less HYPE than the full
        // amount implies, so this single check covers a partial fill too.
        if (hypeOut < minHypeOut) revert InsufficientOutput(hypeOut, minHypeOut);

        WHYPE.withdraw(hypeOut);
    }

    /// @notice Pays the pool for the USDC leg of a {rebalance} swap.
    /// @dev A V3 pool only ever calls this back on the account that invoked `swap`, so no
    ///      caller other than our own {rebalance} can reach it, and the pool check pins that
    ///      down. Only USDC is ever owed, because we only ever sell USDC, and the safe cast
    ///      rejects a pool that claims otherwise rather than reading the delta as enormous.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != pool) revert UnauthorizedCallback();

        int256 usdcOwed = usdcIsToken0 ? amount0Delta : amount1Delta;
        address(usdc).safeTransfer(msg.sender, SafeCastLib.toUint256(usdcOwed));
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
            address usdc_,
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
            address(usdc),
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

    /// @notice The rebalancing parameters, for keepers and monitoring.
    function rebalanceConfig()
        external
        view
        returns (
            address pool_,
            bool usdcIsToken0_,
            uint256 hypeTarget_,
            uint256 hypeFloor_,
            uint256 minRebalanceUsdc_,
            uint256 maxRebalanceSlippageBps_,
            uint256 usdcBalance
        )
    {
        return (
            pool,
            usdcIsToken0,
            hypeTarget,
            hypeFloor,
            minRebalanceUsdc,
            maxRebalanceSlippageBps,
            address(usdc).balanceOf(address(this))
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

    /// @notice Points rebalancing at a USDC/WHYPE pool, or disables it with the zero address.
    /// @dev Validates the pair so a mistyped address cannot be swapped against.
    function setPool(address pool_) external onlyOwner {
        bool usdcIsToken0_;

        if (pool_ != address(0)) {
            address token0 = IUniswapV3Pool(pool_).token0();
            address token1 = IUniswapV3Pool(pool_).token1();
            address usdc_ = address(usdc);

            if (token0 == usdc_ && token1 == address(WHYPE)) {
                usdcIsToken0_ = true;
            } else if (token1 == usdc_ && token0 == address(WHYPE)) {
                usdcIsToken0_ = false;
            } else {
                revert InvalidPool();
            }
        }

        pool = pool_;
        usdcIsToken0 = usdcIsToken0_;
        emit PoolUpdated(pool_, usdcIsToken0_);
    }

    function setRebalanceConfig(
        uint256 hypeTarget_,
        uint256 hypeFloor_,
        uint256 minRebalanceUsdc_,
        uint256 maxRebalanceSlippageBps_
    ) external onlyOwner {
        // The floor must sit strictly below the target, or a rebalance could not lift the
        // balance clear of it and callers could re-trigger swaps indefinitely.
        if (hypeFloor_ >= hypeTarget_) revert InvalidRebalanceConfig();
        if (minRebalanceUsdc_ == 0) revert InvalidRebalanceConfig();
        if (maxRebalanceSlippageBps_ == 0 || maxRebalanceSlippageBps_ > MAX_REBALANCE_SLIPPAGE_BPS) {
            revert InvalidRebalanceConfig();
        }

        hypeTarget = hypeTarget_;
        hypeFloor = hypeFloor_;
        minRebalanceUsdc = minRebalanceUsdc_;
        maxRebalanceSlippageBps = maxRebalanceSlippageBps_;
        emit RebalanceConfigUpdated(hypeTarget_, hypeFloor_, minRebalanceUsdc_, maxRebalanceSlippageBps_);
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
        address(usdc).safeTransfer(to, amount);
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
    /// @dev Also fires when WHYPE is unwrapped during a {rebalance}, which is a genuine
    ///      deposit of HYPE into the contract.
    receive() external payable {
        emit HypeDeposited(msg.sender, msg.value);
    }
}
