// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title TokenRegistry
 * @notice Registry for supported tokens in the Atoshi privacy system
 * @dev Manages whitelisted tokens, their configurations, and metadata
 * 
 * Supported token types:
 * - Native token (ATOS)
 * - ERC20 tokens
 * - ERC721 NFTs (future)
 * - SBT (Soulbound Tokens) (future)
 */
contract TokenRegistry is Ownable {
    // ============ Enums ============
    
    enum TokenType {
        NATIVE,     // Native chain token
        ERC20,      // Fungible token
        ERC721,     // Non-fungible token
        SBT         // Soulbound token
    }

    // ============ Structs ============
    
    struct TokenInfo {
        address tokenAddress;
        TokenType tokenType;
        string symbol;
        uint8 decimals;
        uint256 minDeposit;
        uint256 maxDeposit;
        bool enabled;
        uint256 totalDeposited;
        uint256 totalWithdrawn;
    }

    // ============ State Variables ============
    
    // Token ID counter
    uint256 public nextTokenId;
    
    // Token ID => Token Info
    mapping(uint256 => TokenInfo) public tokens;
    
    // Token address => Token ID (for quick lookup)
    mapping(address => uint256) public tokenIds;
    
    // Token address => is registered
    mapping(address => bool) public isRegistered;
    
    // Native token placeholder
    address public constant NATIVE_TOKEN = address(0);
    uint256 public constant NATIVE_TOKEN_ID = 0;

    // ============ Events ============
    
    event TokenRegistered(
        uint256 indexed tokenId,
        address indexed tokenAddress,
        TokenType tokenType,
        string symbol
    );
    
    event TokenUpdated(
        uint256 indexed tokenId,
        uint256 minDeposit,
        uint256 maxDeposit,
        bool enabled
    );
    
    event TokenRemoved(uint256 indexed tokenId, address indexed tokenAddress);

    // ============ Constructor ============
    
    constructor() Ownable(msg.sender) {
        // Register native token (ID = 0)
        tokens[NATIVE_TOKEN_ID] = TokenInfo({
            tokenAddress: NATIVE_TOKEN,
            tokenType: TokenType.NATIVE,
            symbol: "ATOS",
            decimals: 18,
            minDeposit: 0.01 ether,
            maxDeposit: 10000 ether,
            enabled: true,
            totalDeposited: 0,
            totalWithdrawn: 0
        });
        
        tokenIds[NATIVE_TOKEN] = NATIVE_TOKEN_ID;
        isRegistered[NATIVE_TOKEN] = true;
        nextTokenId = 1;
        
        emit TokenRegistered(NATIVE_TOKEN_ID, NATIVE_TOKEN, TokenType.NATIVE, "ATOS");
    }

    // ============ External Functions ============
    
    /**
     * @notice Register a new ERC20 token
     * @param _token Token contract address
     * @param _minDeposit Minimum deposit amount
     * @param _maxDeposit Maximum deposit amount
     * @return tokenId The assigned token ID
     */
    function registerERC20(
        address _token,
        uint256 _minDeposit,
        uint256 _maxDeposit
    ) external onlyOwner returns (uint256 tokenId) {
        require(_token != address(0), "TokenRegistry: invalid address");
        require(!isRegistered[_token], "TokenRegistry: already registered");
        require(_minDeposit <= _maxDeposit, "TokenRegistry: invalid limits");
        
        // Get token metadata
        string memory symbol;
        uint8 decimals;
        
        try IERC20Metadata(_token).symbol() returns (string memory s) {
            symbol = s;
        } catch {
            symbol = "UNKNOWN";
        }
        
        try IERC20Metadata(_token).decimals() returns (uint8 d) {
            decimals = d;
        } catch {
            decimals = 18;
        }
        
        tokenId = nextTokenId++;
        
        tokens[tokenId] = TokenInfo({
            tokenAddress: _token,
            tokenType: TokenType.ERC20,
            symbol: symbol,
            decimals: decimals,
            minDeposit: _minDeposit,
            maxDeposit: _maxDeposit,
            enabled: true,
            totalDeposited: 0,
            totalWithdrawn: 0
        });
        
        tokenIds[_token] = tokenId;
        isRegistered[_token] = true;
        
        emit TokenRegistered(tokenId, _token, TokenType.ERC20, symbol);
    }

    /**
     * @notice Register a new ERC721 token (NFT)
     * @param _token NFT contract address
     * @return tokenId The assigned token ID
     */
    function registerERC721(
        address _token
    ) external onlyOwner returns (uint256 tokenId) {
        require(_token != address(0), "TokenRegistry: invalid address");
        require(!isRegistered[_token], "TokenRegistry: already registered");
        
        // Verify it's an ERC721
        try IERC721(_token).supportsInterface(0x80ac58cd) returns (bool supported) {
            require(supported, "TokenRegistry: not ERC721");
        } catch {
            revert("TokenRegistry: not ERC721");
        }
        
        tokenId = nextTokenId++;
        
        tokens[tokenId] = TokenInfo({
            tokenAddress: _token,
            tokenType: TokenType.ERC721,
            symbol: "NFT",
            decimals: 0,
            minDeposit: 1, // 1 NFT
            maxDeposit: 1, // 1 NFT per deposit
            enabled: true,
            totalDeposited: 0,
            totalWithdrawn: 0
        });
        
        tokenIds[_token] = tokenId;
        isRegistered[_token] = true;
        
        emit TokenRegistered(tokenId, _token, TokenType.ERC721, "NFT");
    }

    /**
     * @notice Update token configuration
     * @param _tokenId Token ID to update
     * @param _minDeposit New minimum deposit
     * @param _maxDeposit New maximum deposit
     * @param _enabled Enable/disable token
     */
    function updateToken(
        uint256 _tokenId,
        uint256 _minDeposit,
        uint256 _maxDeposit,
        bool _enabled
    ) external onlyOwner {
        require(_tokenId < nextTokenId, "TokenRegistry: invalid token ID");
        require(_minDeposit <= _maxDeposit, "TokenRegistry: invalid limits");
        
        TokenInfo storage token = tokens[_tokenId];
        token.minDeposit = _minDeposit;
        token.maxDeposit = _maxDeposit;
        token.enabled = _enabled;
        
        emit TokenUpdated(_tokenId, _minDeposit, _maxDeposit, _enabled);
    }

    /**
     * @notice Remove a token from registry
     * @param _tokenId Token ID to remove
     */
    function removeToken(uint256 _tokenId) external onlyOwner {
        require(_tokenId != NATIVE_TOKEN_ID, "TokenRegistry: cannot remove native");
        require(_tokenId < nextTokenId, "TokenRegistry: invalid token ID");
        
        TokenInfo storage token = tokens[_tokenId];
        address tokenAddress = token.tokenAddress;
        
        token.enabled = false;
        isRegistered[tokenAddress] = false;
        
        emit TokenRemoved(_tokenId, tokenAddress);
    }

    /**
     * @notice Record a deposit (called by Shield contract)
     * @param _tokenId Token ID
     * @param _amount Amount deposited
     */
    function recordDeposit(uint256 _tokenId, uint256 _amount) external {
        // In production, add access control (only Shield can call)
        tokens[_tokenId].totalDeposited += _amount;
    }

    /**
     * @notice Record a withdrawal (called by Shield contract)
     * @param _tokenId Token ID
     * @param _amount Amount withdrawn
     */
    function recordWithdrawal(uint256 _tokenId, uint256 _amount) external {
        // In production, add access control (only Shield can call)
        tokens[_tokenId].totalWithdrawn += _amount;
    }

    // ============ View Functions ============
    
    /**
     * @notice Get token info by address
     */
    function getTokenByAddress(
        address _token
    ) external view returns (TokenInfo memory) {
        require(isRegistered[_token], "TokenRegistry: not registered");
        return tokens[tokenIds[_token]];
    }

    /**
     * @notice Get token info by ID
     */
    function getTokenById(
        uint256 _tokenId
    ) external view returns (TokenInfo memory) {
        require(_tokenId < nextTokenId, "TokenRegistry: invalid token ID");
        return tokens[_tokenId];
    }

    /**
     * @notice Check if token is enabled for deposits
     */
    function isTokenEnabled(address _token) external view returns (bool) {
        if (!isRegistered[_token]) return false;
        return tokens[tokenIds[_token]].enabled;
    }

    /**
     * @notice Validate deposit amount
     */
    function validateDeposit(
        address _token,
        uint256 _amount
    ) external view returns (bool) {
        if (!isRegistered[_token]) return false;
        
        TokenInfo storage token = tokens[tokenIds[_token]];
        if (!token.enabled) return false;
        if (_amount < token.minDeposit) return false;
        if (_amount > token.maxDeposit) return false;
        
        return true;
    }

    /**
     * @notice Get all registered token IDs
     */
    function getAllTokenIds() external view returns (uint256[] memory) {
        uint256[] memory ids = new uint256[](nextTokenId);
        for (uint256 i = 0; i < nextTokenId; i++) {
            ids[i] = i;
        }
        return ids;
    }

    /**
     * @notice Get pool statistics for a token
     */
    function getPoolStats(
        uint256 _tokenId
    ) external view returns (
        uint256 totalDeposited,
        uint256 totalWithdrawn,
        uint256 currentBalance
    ) {
        TokenInfo storage token = tokens[_tokenId];
        totalDeposited = token.totalDeposited;
        totalWithdrawn = token.totalWithdrawn;
        currentBalance = totalDeposited - totalWithdrawn;
    }
}

