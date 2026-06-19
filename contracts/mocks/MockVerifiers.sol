// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockVerifiers
 * @notice Drop-in replacement verifier contracts used by unit tests.
 *         They expose the exact same verifyProof signatures as the
 *         auto-generated Groth16 verifiers in contracts/verifiers/,
 *         but bypass the cryptographic check and instead return a
 *         flag that the test can toggle.
 *
 * Why: generating a real Groth16 proof on a hardhat ephemeral node
 *      takes 1-3s per call, multiplies by the dozens of cases in
 *      Shield.test.js / Shield.multiLeaf.test.js, and makes the unit
 *      test suite take minutes. Real ZK flow is covered by the
 *      separate Shield.e2e.test.js which uses the actual circuit
 *      keys. Everything else mocks here.
 *
 * Each mock exposes setResult(bool) so a test can also exercise the
 * "invalid proof" reject path without having to construct a
 * deliberately-bad proof.
 */

contract MockShieldVerifier {
    bool public result = true;

    function setResult(bool _r) external {
        result = _r;
    }

    /// @notice Mirrors the auto-generated ShieldVerifier signature
    ///         (3 public signals: commitment, amount, tokenId).
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[3] calldata
    ) external view returns (bool) {
        return result;
    }
}

contract MockTransferVerifier {
    bool public result = true;

    function setResult(bool _r) external {
        result = _r;
    }

    /// @notice Mirrors the auto-generated TransferVerifier signature
    ///         (3 public signals: root, nullifierHash, newCommitment).
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[3] calldata
    ) external view returns (bool) {
        return result;
    }
}

contract MockUnshieldVerifier {
    bool public result = true;

    function setResult(bool _r) external {
        result = _r;
    }

    /// @notice Mirrors the auto-generated UnshieldVerifier signature
    ///         (7 public signals: root, nullifierHash, recipient,
    ///         relayer, tokenId, amount, fee). Updated from [6] to
    ///         [7] in audit Issue 4's relayer-binding fix.
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[7] calldata
    ) external view returns (bool) {
        return result;
    }
}
