// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPoseidon
 * @notice Interface for Poseidon hash function (ZK-friendly)
 */
interface IPoseidon {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
    function poseidon(uint256[3] calldata inputs) external pure returns (uint256);
}

/**
 * @title IVerifier
 * @notice Interface for ZK-SNARK verifier
 */
interface IVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title IShield
 * @notice Interface for Shield contract
 */
interface IShield {
    // Events
    event Deposit(
        uint256 indexed commitment,
        uint256 leafIndex,
        uint256 timestamp,
        address indexed token,
        uint256 amount
    );

    event Withdrawal(
        address indexed recipient,
        uint256 indexed nullifierHash,
        address indexed relayer,
        uint256 fee
    );

    event Transfer(
        uint256 indexed nullifierHash,
        uint256 indexed newCommitment
    );

    // Functions
    function deposit(
        uint256 commitment,
        address token,
        uint256 amount
    ) external payable;

    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee,
        address _token,
        uint256 _amount
    ) external;

    function isKnownRoot(uint256 _root) external view returns (bool);
    function isSpent(uint256 _nullifierHash) external view returns (bool);
}

