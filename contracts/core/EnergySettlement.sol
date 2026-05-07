// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EnergySettlement
 * @notice L2-side accounting for the Relayer model that lets users pay
 *         gas with the L1 energy they have delegated to a relayer pool.
 *
 * Background — the privacy split:
 *   On L1 (Atoshi Cosmos-EVM) users hold ATOS, accrue TxEnergy, and
 *   delegate energy to a relayer pool address via x/energy. On L2
 *   (this chain) the Shield privacy contract lives. When a user
 *   submits a withdraw / transfer, they prove ownership privately
 *   and a registered Relayer broadcasts the tx for them — paying L2
 *   gas — in exchange for a fee deducted from the withdrawal amount.
 *
 *   For the Relayer's gas to be subsidised by the user's L1 energy,
 *   the L2 needs to mirror "how much gas this Relayer is allowed to
 *   spend in the current window". That mirror is this contract.
 *
 * Quota lifecycle:
 *   - registerRelayer(addr, capacity, window): owner whitelists a
 *     Relayer with a per-window gas budget. window defaults to 24h
 *     and can be tuned per Relayer (e.g. tighter window for newer
 *     relayers).
 *   - consumeForRelayer(addr, gasUsed): only Shield calls this; if
 *     the window expired, consumed resets to 0 first; reverts if
 *     the request would push consumed past capacity.
 *
 * Why this contract is *separate* from Shield:
 *   - Audit boundary: a bug in quota math should not put commitments
 *     at risk.
 *   - Multiple privacy contracts can share one EnergySettlement in
 *     the future (e.g. shielded token + shielded NFT).
 *   - Quota updates from L1 (a future bridge sync) only need to
 *     touch this contract.
 *
 * Cross-chain trust model (v1):
 *   The owner is a multisig. It registers Relayers and bumps their
 *   capacity manually based on what the L1 x/energy module reports.
 *   v2 will replace the multisig with an L1 -> L2 bridge message so
 *   capacity updates ride the same finality as deposits/withdrawals.
 */
contract EnergySettlement is Ownable {
    /// Per-relayer quota record.
    struct RelayerQuota {
        uint256 capacity;       // Max gas spendable per window
        uint256 consumed;       // Spent in the current window
        uint64 windowSeconds;   // Length of one window (0 means uninitialised)
        uint64 lastResetAt;     // Unix time of the most recent reset
    }

    /// Default reset window for newly-registered relayers.
    uint64 public constant DEFAULT_WINDOW = 1 days;

    /// Map relayer address → its quota record.
    mapping(address => RelayerQuota) public quotas;

    /// Address of the Shield contract authorised to call consumeForRelayer.
    /// Can be set to address(0) to disable consumption-mode entirely
    /// while keeping the registry queryable.
    address public shield;

    event RelayerRegistered(address indexed relayer, uint256 capacity, uint64 windowSeconds);
    event RelayerCapacityUpdated(address indexed relayer, uint256 oldCapacity, uint256 newCapacity);
    event RelayerRemoved(address indexed relayer);
    event QuotaConsumed(address indexed relayer, uint256 gasUsed, uint256 totalConsumedThisWindow);
    event WindowReset(address indexed relayer, uint64 newLastResetAt);
    event ShieldUpdated(address indexed oldShield, address indexed newShield);

    constructor() Ownable(msg.sender) {}

    /// Restrict consumeForRelayer to the configured Shield.
    modifier onlyShield() {
        require(msg.sender == shield, "EnergySettlement: not shield");
        _;
    }

    // =====================================================
    // Owner / governance
    // =====================================================

    /**
     * @notice Set or rotate the Shield contract address that may
     *         consume quota. Use address(0) to pause consumption.
     */
    function setShield(address _shield) external onlyOwner {
        emit ShieldUpdated(shield, _shield);
        shield = _shield;
    }

    /**
     * @notice Register a new relayer with a per-window capacity.
     *         windowSeconds=0 falls back to DEFAULT_WINDOW.
     *         Re-registering the same relayer overrides previous
     *         settings without resetting `consumed`.
     */
    function registerRelayer(
        address relayer,
        uint256 capacity,
        uint64 windowSeconds
    ) external onlyOwner {
        require(relayer != address(0), "EnergySettlement: zero relayer");
        require(capacity > 0, "EnergySettlement: zero capacity");
        RelayerQuota storage q = quotas[relayer];
        q.capacity = capacity;
        q.windowSeconds = windowSeconds == 0 ? DEFAULT_WINDOW : windowSeconds;
        if (q.lastResetAt == 0) {
            q.lastResetAt = uint64(block.timestamp);
        }
        emit RelayerRegistered(relayer, capacity, q.windowSeconds);
    }

    /**
     * @notice Bump or shrink a relayer's capacity without touching
     *         their consumed counter or window. Common path when L1
     *         energy delegations to this relayer change.
     */
    function setRelayerCapacity(address relayer, uint256 newCapacity) external onlyOwner {
        RelayerQuota storage q = quotas[relayer];
        require(q.windowSeconds != 0, "EnergySettlement: relayer not registered");
        emit RelayerCapacityUpdated(relayer, q.capacity, newCapacity);
        q.capacity = newCapacity;
    }

    /**
     * @notice Permanently remove a relayer; subsequent
     *         consumeForRelayer calls will revert with
     *         "relayer not registered".
     */
    function removeRelayer(address relayer) external onlyOwner {
        delete quotas[relayer];
        emit RelayerRemoved(relayer);
    }

    // =====================================================
    // Shield-side consumption
    // =====================================================

    /**
     * @notice Charge `gasUsed` against `relayer`'s quota. Auto-resets
     *         the window if it has expired. Reverts when the relayer
     *         would exceed its budget — Shield should treat this as
     *         "relayer cannot subsidise this withdrawal" and either
     *         reject the tx or fall back to standard fee.
     */
    function consumeForRelayer(address relayer, uint256 gasUsed) external onlyShield {
        RelayerQuota storage q = quotas[relayer];
        require(q.windowSeconds != 0, "EnergySettlement: relayer not registered");

        // Lazy reset: if the current window has elapsed, start a fresh
        // one. We use windowSeconds-aligned resets rather than a moving
        // window so accounting is predictable for off-chain operators.
        uint256 elapsed = block.timestamp - q.lastResetAt;
        if (elapsed >= q.windowSeconds) {
            q.consumed = 0;
            q.lastResetAt = uint64(block.timestamp);
            emit WindowReset(relayer, q.lastResetAt);
        }

        uint256 newConsumed = q.consumed + gasUsed;
        require(newConsumed <= q.capacity, "EnergySettlement: quota exhausted");
        q.consumed = newConsumed;

        emit QuotaConsumed(relayer, gasUsed, newConsumed);
    }

    // =====================================================
    // Views
    // =====================================================

    /**
     * @notice Currently-spendable quota for a relayer, accounting for
     *         a possibly-elapsed window. Off-chain code calls this to
     *         pre-flight a withdrawal before broadcasting.
     */
    function availableQuota(address relayer) external view returns (uint256) {
        RelayerQuota memory q = quotas[relayer];
        if (q.windowSeconds == 0) return 0;
        if (block.timestamp - q.lastResetAt >= q.windowSeconds) {
            // Window elapsed → full capacity available again.
            return q.capacity;
        }
        if (q.consumed >= q.capacity) return 0;
        return q.capacity - q.consumed;
    }

    /**
     * @notice True iff `relayer` is currently registered with non-zero
     *         capacity.
     */
    function isRegistered(address relayer) external view returns (bool) {
        return quotas[relayer].windowSeconds != 0;
    }
}
