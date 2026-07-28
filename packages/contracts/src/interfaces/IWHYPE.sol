// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Wrapped HYPE, a WETH9 clone at a fixed address on HyperEVM.
interface IWHYPE {
    /// @notice Burns `amount` of wrapped HYPE and returns the same amount of native HYPE.
    function withdraw(uint256 amount) external;
}
