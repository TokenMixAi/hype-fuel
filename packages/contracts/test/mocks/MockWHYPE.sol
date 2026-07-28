// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @notice Minimal WETH9 clone, etched over the real WHYPE address in hermetic tests.
/// @dev The fork suite exercises the real wrapper, so this only has to be faithful in the
///      two directions HypeFuel uses: receiving wrapped tokens and unwrapping them.
contract MockWHYPE {
    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed to, uint256 amount);
    event Withdrawal(address indexed from, uint256 amount);

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    receive() external payable {
        deposit();
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        emit Withdrawal(msg.sender, amount);
        SafeTransferLib.safeTransferETH(msg.sender, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
