// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HypeFuel} from "../../src/HypeFuel.sol";

/// @notice A plausible future implementation, used to prove upgrades keep state intact.
/// @dev Extending HypeFuel is how real upgrades should be written: inheritance forces new
///      state to sit after every existing slot.
contract HypeFuelV2 is HypeFuel {
    uint256 public appendedValue;

    function setAppendedValue(uint256 appendedValue_) external onlyOwner {
        appendedValue = appendedValue_;
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice An implementation that is not UUPS-compatible, so upgrades to it must be refused.
contract NotUUPS {
    function someFunction() external pure returns (uint256) {
        return 1;
    }
}
