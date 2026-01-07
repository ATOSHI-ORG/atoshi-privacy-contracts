// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IShield.sol";
import "../libraries/MerkleTree.sol";
import "../libraries/Poseidon.sol";

/**
 * @title Shield
 * @notice Main privacy pool contract for Atoshi Chain
 * @dev Implements deposit/withdraw functionality with ZK proof verification
 * 
 * Architecture:
 * - Users deposit tokens and receive a commitment (stored in Merkle tree)
 * - Users can withdraw by providing a valid ZK proof
 * - Nullifiers prevent double-spending
 * - Supports native token (ATOS) and ERC20 tokens
 * 
 * Note Structure (off-chain):
 * - commitment = Poseidon(amount, token, pubKey, blinding)
 * - nullifier = Poseidon(commitment, privKey, leafIndex)
 */
contract Shield is IShield, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using MerkleTree for MerkleTree.TreeData;

    // ============ Constants ============
    
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant TREE_LEVELS = 20; // Supports 2^20 = ~1M deposits
    uint32 public constant ROOT_HISTORY_SIZE = 100;
    
    // Native token address placeholder
    address public constant NATIVE_TOKEN = address(0);

    // ============ State Variables ============
    
    // Verifier contract for ZK proofs
    address public verifier;
    
    // Merkle tree for commitments
    MerkleTree.TreeData private commitmentTree;
    
    // Nullifier registry (nullifierHash => spent)
    mapping(uint256 => bool) public nullifierHashes;
    
    // Token whitelist (token => enabled)
    mapping(address => bool) public supportedTokens;
    
    // Minimum deposit amounts per token
    mapping(address => uint256) public minDeposits;
    
    // Protocol fee (basis points, e.g., 30 = 0.3%)
    uint256 public protocolFeeBps;
    address public feeRecipient;
    
    // Emergency pause
    bool public paused;

    // Zero values for Merkle tree initialization
    uint256[] private zeros;

    // ============ Modifiers ============
    
    modifier whenNotPaused() {
        require(!paused, "Shield: paused");
        _;
    }
    
    modifier validToken(address _token) {
        require(supportedTokens[_token], "Shield: unsupported token");
        _;
    }

    // ============ Constructor ============
    
    /**
     * @notice Initialize the Shield contract
     * @param _verifier Address of the ZK verifier contract
     * @param _feeRecipient Address to receive protocol fees
     */
    constructor(
        address _verifier,
        address _feeRecipient
    ) Ownable(msg.sender) {
        require(_verifier != address(0), "Shield: invalid verifier");
        
        verifier = _verifier;
        feeRecipient = _feeRecipient;
        protocolFeeBps = 30; // 0.3% default fee
        
        // Initialize zero values for Merkle tree
        _initializeZeros();
        
        // Initialize Merkle tree
        commitmentTree.initialize(TREE_LEVELS, ROOT_HISTORY_SIZE, zeros);
        
        // Enable native token by default
        supportedTokens[NATIVE_TOKEN] = true;
    }

    // ============ External Functions ============
    
    /**
     * @notice Deposit tokens into the privacy pool
     * @param _commitment The commitment hash (computed off-chain)
     * @param _token Token address (address(0) for native token)
     * @param _amount Amount to deposit
     */
    function deposit(
        uint256 _commitment,
        address _token,
        uint256 _amount
    ) external payable override nonReentrant whenNotPaused validToken(_token) {
        require(_commitment < FIELD_SIZE, "Shield: invalid commitment");
        require(_amount >= minDeposits[_token], "Shield: amount too small");
        
        // Handle token transfer
        if (_token == NATIVE_TOKEN) {
            require(msg.value == _amount, "Shield: incorrect native amount");
        } else {
            require(msg.value == 0, "Shield: unexpected native token");
            IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        }
        
        // Insert commitment into Merkle tree
        uint32 leafIndex = commitmentTree.insert(_commitment);
        
        emit Deposit(_commitment, leafIndex, block.timestamp, _token, _amount);
    }

    /**
     * @notice Withdraw tokens from the privacy pool
     * @param _pA Proof element A
     * @param _pB Proof element B
     * @param _pC Proof element C
     * @param _root Merkle root used in proof
     * @param _nullifierHash Nullifier hash to prevent double-spend
     * @param _recipient Address to receive tokens
     * @param _relayer Relayer address (for gas abstraction)
     * @param _fee Fee to pay relayer
     * @param _token Token to withdraw
     * @param _amount Amount to withdraw
     */
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
    ) external override nonReentrant whenNotPaused validToken(_token) {
        require(_nullifierHash < FIELD_SIZE, "Shield: invalid nullifier");
        require(!nullifierHashes[_nullifierHash], "Shield: already spent");
        require(isKnownRoot(_root), "Shield: unknown root");
        require(_recipient != address(0), "Shield: invalid recipient");
        require(_fee <= _amount, "Shield: fee exceeds amount");
        
        // Verify ZK proof
        // Public inputs: root, nullifierHash, recipient, token, amount, fee
        uint256[] memory pubSignals = new uint256[](6);
        pubSignals[0] = _root;
        pubSignals[1] = _nullifierHash;
        pubSignals[2] = uint256(uint160(_recipient));
        pubSignals[3] = uint256(uint160(_token));
        pubSignals[4] = _amount;
        pubSignals[5] = _fee;
        
        require(
            IVerifier(verifier).verifyProof(_pA, _pB, _pC, pubSignals),
            "Shield: invalid proof"
        );
        
        // Mark nullifier as spent
        nullifierHashes[_nullifierHash] = true;
        
        // Calculate protocol fee
        uint256 protocolFee = (_amount * protocolFeeBps) / 10000;
        uint256 netAmount = _amount - _fee - protocolFee;
        
        // Transfer tokens
        if (_token == NATIVE_TOKEN) {
            // Transfer to recipient
            (bool success1, ) = _recipient.call{value: netAmount}("");
            require(success1, "Shield: native transfer failed");
            
            // Transfer relayer fee
            if (_fee > 0 && _relayer != address(0)) {
                (bool success2, ) = _relayer.call{value: _fee}("");
                require(success2, "Shield: relayer fee transfer failed");
            }
            
            // Transfer protocol fee
            if (protocolFee > 0 && feeRecipient != address(0)) {
                (bool success3, ) = payable(feeRecipient).call{value: protocolFee}("");
                require(success3, "Shield: protocol fee transfer failed");
            }
        } else {
            IERC20(_token).safeTransfer(_recipient, netAmount);
            
            if (_fee > 0 && _relayer != address(0)) {
                IERC20(_token).safeTransfer(_relayer, _fee);
            }
            
            if (protocolFee > 0 && feeRecipient != address(0)) {
                IERC20(_token).safeTransfer(feeRecipient, protocolFee);
            }
        }
        
        emit Withdrawal(_recipient, _nullifierHash, _relayer, _fee);
    }

    /**
     * @notice Private transfer within the pool (spend old note, create new note)
     * @dev This allows transferring ownership without leaving the pool
     */
    function transfer(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash,
        uint256 _newCommitment
    ) external nonReentrant whenNotPaused {
        require(_nullifierHash < FIELD_SIZE, "Shield: invalid nullifier");
        require(_newCommitment < FIELD_SIZE, "Shield: invalid commitment");
        require(!nullifierHashes[_nullifierHash], "Shield: already spent");
        require(isKnownRoot(_root), "Shield: unknown root");
        
        // Verify ZK proof for transfer
        uint256[] memory pubSignals = new uint256[](3);
        pubSignals[0] = _root;
        pubSignals[1] = _nullifierHash;
        pubSignals[2] = _newCommitment;
        
        require(
            IVerifier(verifier).verifyProof(_pA, _pB, _pC, pubSignals),
            "Shield: invalid proof"
        );
        
        // Mark old nullifier as spent
        nullifierHashes[_nullifierHash] = true;
        
        // Insert new commitment
        commitmentTree.insert(_newCommitment);
        
        emit Transfer(_nullifierHash, _newCommitment);
    }

    // ============ View Functions ============
    
    /**
     * @notice Check if a root is in the history
     */
    function isKnownRoot(uint256 _root) public view override returns (bool) {
        return commitmentTree.isKnownRoot(_root);
    }
    
    /**
     * @notice Check if a nullifier has been spent
     */
    function isSpent(uint256 _nullifierHash) public view override returns (bool) {
        return nullifierHashes[_nullifierHash];
    }
    
    /**
     * @notice Get the current Merkle root
     */
    function getLastRoot() public view returns (uint256) {
        return commitmentTree.getLastRoot();
    }
    
    /**
     * @notice Get the next leaf index
     */
    function getNextIndex() public view returns (uint32) {
        return commitmentTree.nextIndex;
    }

    // ============ Admin Functions ============
    
    /**
     * @notice Add a supported token
     */
    function addSupportedToken(
        address _token,
        uint256 _minDeposit
    ) external onlyOwner {
        supportedTokens[_token] = true;
        minDeposits[_token] = _minDeposit;
    }
    
    /**
     * @notice Remove a supported token
     */
    function removeSupportedToken(address _token) external onlyOwner {
        supportedTokens[_token] = false;
    }
    
    /**
     * @notice Update verifier contract
     */
    function setVerifier(address _verifier) external onlyOwner {
        require(_verifier != address(0), "Shield: invalid verifier");
        verifier = _verifier;
    }
    
    /**
     * @notice Update protocol fee
     */
    function setProtocolFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Shield: fee too high"); // Max 10%
        protocolFeeBps = _feeBps;
    }
    
    /**
     * @notice Update fee recipient
     */
    function setFeeRecipient(address _recipient) external onlyOwner {
        feeRecipient = _recipient;
    }
    
    /**
     * @notice Emergency pause
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    // ============ Internal Functions ============
    
    /**
     * @notice Initialize zero values for Merkle tree
     * @dev zeros[i] = hash of empty subtree at level i
     *      zeros[0] = hash of empty leaf
     *      zeros[i] = hash(zeros[i-1], zeros[i-1])
     */
    function _initializeZeros() internal {
        zeros = new uint256[](TREE_LEVELS);
        
        // Start with zero leaf value
        uint256 currentZero = 0;
        
        for (uint32 i = 0; i < TREE_LEVELS; i++) {
            zeros[i] = currentZero;
            // Next level zero = hash(currentZero, currentZero)
            uint256[2] memory inputs;
            inputs[0] = currentZero;
            inputs[1] = currentZero;
            currentZero = PoseidonT3.poseidon(inputs);
        }
    }

    // ============ Receive Function ============
    
    receive() external payable {
        // Allow receiving native tokens
    }
}

