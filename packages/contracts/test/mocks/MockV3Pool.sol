// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Uniswap V3 pool stand-in for a USDC/WHYPE pair.
///
/// @dev Reproduces the parts of the real pool's contract that HypeFuel depends on: signed
///      deltas, paying the recipient before invoking the callback, and refusing to settle
///      unless the callback pays. Execution price is settable so tests can drive good fills,
///      manipulated fills and partial fills without needing a fork.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;

    /// @notice HYPE price the pool fills at, 1e8-scaled.
    uint256 public priceUsd1e8;

    /// @notice How much worse than {priceUsd1e8} the fill lands, in basis points.
    uint256 public executionPenaltyBps;

    /// @notice When set, the pool consumes only this much of the requested input.
    uint256 public partialFillUsdc;

    error PayerDidNotPay();

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setPrice(uint256 priceUsd1e8_) external {
        priceUsd1e8 = priceUsd1e8_;
    }

    function setExecutionPenaltyBps(uint256 executionPenaltyBps_) external {
        executionPenaltyBps = executionPenaltyBps_;
    }

    function setPartialFillUsdc(uint256 partialFillUsdc_) external {
        partialFillUsdc = partialFillUsdc_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "AS");

        address usdcToken = zeroForOne ? token0 : token1;
        address whypeToken = zeroForOne ? token1 : token0;

        uint256 usdcIn = uint256(amountSpecified);
        if (partialFillUsdc != 0 && partialFillUsdc < usdcIn) usdcIn = partialFillUsdc;

        uint256 hypeOut = (usdcIn * 1e20 * (10_000 - executionPenaltyBps)) / (priceUsd1e8 * 10_000);

        (amount0, amount1) = zeroForOne ? (int256(usdcIn), -int256(hypeOut)) : (-int256(hypeOut), int256(usdcIn));

        IERC20Like(whypeToken).transfer(recipient, hypeOut);

        uint256 owedFrom = IERC20Like(usdcToken).balanceOf(address(this)) + usdcIn;
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        if (IERC20Like(usdcToken).balanceOf(address(this)) < owedFrom) revert PayerDidNotPay();
    }
}
