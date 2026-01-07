// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Poseidon.sol";

/**
 * @title MerkleTree
 * @notice Incremental Merkle Tree for storing commitments
 * @dev Uses Poseidon hash function for ZK-friendliness
 *      Tree depth is fixed at deployment
 */
library MerkleTree {
    uint256 constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    
    // Zero values for each level of the tree (precomputed)
    // zeros[i] = hash of empty subtree at level i
    // These should be computed off-chain and hardcoded for gas efficiency
    
    struct TreeData {
        uint32 levels;
        uint32 nextIndex;
        mapping(uint256 => uint256) filledSubtrees;
        mapping(uint256 => uint256) roots;
        uint32 currentRootIndex;
        uint32 rootHistorySize;
    }

    /**
     * @notice Initialize the Merkle tree
     * @param self The tree data storage
     * @param _levels Depth of the tree
     * @param _rootHistorySize Number of historical roots to store
     * @param _zeros Array of zero values for each level
     */
    function initialize(
        TreeData storage self,
        uint32 _levels,
        uint32 _rootHistorySize,
        uint256[] memory _zeros
    ) internal {
        require(_levels > 0 && _levels <= 32, "Invalid tree depth");
        require(_rootHistorySize > 0, "Invalid root history size");
        require(_zeros.length == _levels, "Invalid zeros array length");
        
        self.levels = _levels;
        self.rootHistorySize = _rootHistorySize;
        
        // Initialize filled subtrees with zero values
        for (uint32 i = 0; i < _levels; i++) {
            self.filledSubtrees[i] = _zeros[i];
        }
        
        // Set initial root (empty tree root)
        self.roots[0] = _zeros[_levels - 1];
    }

    /**
     * @notice Insert a new leaf into the tree
     * @param self The tree data storage
     * @param _leaf The leaf value to insert
     * @return index The index of the inserted leaf
     */
    function insert(
        TreeData storage self,
        uint256 _leaf
    ) internal returns (uint32 index) {
        uint32 _nextIndex = self.nextIndex;
        require(_nextIndex < uint32(2) ** self.levels, "Merkle tree is full");
        
        uint32 currentIndex = _nextIndex;
        uint256 currentLevelHash = _leaf;
        uint256 left;
        uint256 right;
        
        for (uint32 i = 0; i < self.levels; i++) {
            if (currentIndex % 2 == 0) {
                // Current node is a left child
                left = currentLevelHash;
                right = self.filledSubtrees[i];
                self.filledSubtrees[i] = currentLevelHash;
            } else {
                // Current node is a right child
                left = self.filledSubtrees[i];
                right = currentLevelHash;
            }
            
            // Hash the pair to get parent
            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }
        
        // Update root history
        uint32 newRootIndex = (self.currentRootIndex + 1) % self.rootHistorySize;
        self.currentRootIndex = newRootIndex;
        self.roots[newRootIndex] = currentLevelHash;
        
        self.nextIndex = _nextIndex + 1;
        return _nextIndex;
    }

    /**
     * @notice Hash two child nodes to get parent
     * @param _left Left child
     * @param _right Right child
     * @return Parent hash
     */
    function hashLeftRight(
        uint256 _left,
        uint256 _right
    ) internal pure returns (uint256) {
        require(_left < FIELD_SIZE, "Left input exceeds field size");
        require(_right < FIELD_SIZE, "Right input exceeds field size");
        
        uint256[2] memory inputs;
        inputs[0] = _left;
        inputs[1] = _right;
        
        return PoseidonT3.poseidon(inputs);
    }

    /**
     * @notice Check if a root is in the history
     * @param self The tree data storage
     * @param _root The root to check
     * @return True if root is known
     */
    function isKnownRoot(
        TreeData storage self,
        uint256 _root
    ) internal view returns (bool) {
        if (_root == 0) return false;
        
        uint32 currentIndex = self.currentRootIndex;
        uint32 i = currentIndex;
        
        do {
            if (_root == self.roots[i]) {
                return true;
            }
            if (i == 0) {
                i = self.rootHistorySize - 1;
            } else {
                i--;
            }
        } while (i != currentIndex);
        
        return false;
    }

    /**
     * @notice Get the current root
     * @param self The tree data storage
     * @return The current Merkle root
     */
    function getLastRoot(
        TreeData storage self
    ) internal view returns (uint256) {
        return self.roots[self.currentRootIndex];
    }
}

