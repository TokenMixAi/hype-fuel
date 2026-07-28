// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Subset of EIP-3009 plus ERC-20 reads used by HypeFuel.
/// @dev The `bytes signature` overload is the FiatTokenV2_2 variant, which routes through
///      a signature checker and therefore accepts ERC-1271 smart-contract wallet signatures
///      as well as raw ECDSA.
interface IEIP3009 {
    /// @dev Reverts unless `msg.sender == to`, which is what makes a signed authorization
    ///      safe to broadcast: only the named payee can spend it.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    /// @notice True if `nonce` has already been used or cancelled by `authorizer`.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function decimals() external view returns (uint8);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
