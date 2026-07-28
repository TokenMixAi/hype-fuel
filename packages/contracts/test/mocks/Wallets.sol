// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HypeFuel} from "../../src/HypeFuel.sol";

/// @notice ERC-1271 wallet that approves any signature, optionally re-entering on receipt.
contract ReenteringWallet {
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    HypeFuel internal immutable fuel;
    bool internal immutable reenter;

    HypeFuel.Order internal armedOrder;
    bool internal armed;

    constructor(HypeFuel fuel_, bool reenter_) {
        fuel = fuel_;
        reenter = reenter_;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_MAGIC;
    }

    /// @notice Queues a second, independently valid order to fire during the HYPE transfer.
    function arm(HypeFuel.Order calldata order) external {
        armedOrder = order;
        armed = true;
    }

    receive() external payable {
        if (reenter && armed) {
            armed = false;
            fuel.fill(armedOrder, hex"");
        }
    }
}

/// @notice ERC-1271 wallet that cannot receive native HYPE.
contract RejectingWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}
