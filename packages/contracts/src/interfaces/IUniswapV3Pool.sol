// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The subset of a Uniswap V3 pool that HypeFuel uses.
/// @dev Project X's pools are a faithful V3 fork, so this interface matches theirs exactly.
interface IUniswapV3Pool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    /// @param recipient   Receives the output token.
    /// @param zeroForOne  True when selling `token0` for `token1`.
    /// @param amountSpecified Positive for an exact-input swap.
    /// @param sqrtPriceLimitX96 Price bound the swap may not cross.
    /// @param data        Forwarded verbatim to `uniswapV3SwapCallback`.
    /// @return amount0 Signed change in `token0`, negative when the pool pays it out.
    /// @return amount1 Signed change in `token1`, negative when the pool pays it out.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
