# Atoshi Privacy — design rationale

This document records design decisions that look like bugs but are
intentional, plus protocol-level constraints that aren't enforceable
at the smart-contract layer. Written in response to audit 2026-06
(commit `abd68f4`) questions Q4, Q5, and Q8.

---

## Q5 — One Merkle tree across all assets

### Question
The Shield contract maintains a single `commitmentTree` into which
deposits of every supported token (and every Transfer-created output
commitment) are inserted side by side. Is this intentional, or should
each token have its own tree?

### Answer — intentional
Atoshi pools all assets into one anonymity set on purpose. This is a
deliberate departure from the Tornado Cash mixer model, which uses a
separate pool (and a separate fixed denomination) per asset / amount.

### Rationale

**Anonymity-set size dominates privacy.** Tornado-style fixed-pool
mixers force a deposit-time choice that fragments the user base —
every "0.1 ETH" deposit hides among other 0.1 ETH deposits but not
among 1 ETH ones, and ETH deposits don't hide among DAI deposits at
all. Each pool's anonymity set is small. With a unified tree, every
single deposit (and every internal transfer) joins the same pool, so
the anonymity set grows monotonically with overall product usage
rather than dividing by token × denomination.

**Cross-asset is privacy-preserving because the token field is
private at the right moments.**

- The `tokenId` (token address cast to uint256) is one of the four
  fields hashed into the commitment, so the on-chain Merkle leaf does
  not reveal which token a particular note holds.
- The `transfer()` path emits only `(nullifierHash, newCommitment)`
  — no token information is observable when a user moves value
  inside the pool, regardless of which token's commitment they spent.
- Only on `deposit()` (where the depositor's address and the actual
  ERC-20 transferFrom are inherently public) and on `withdraw()`
  (where the recipient EOA receives an actual token transfer) does
  the token become public. Both endpoints are publicly observable in
  any privacy protocol — Tornado's deposit and Tornado's withdraw
  both expose the asset and amount too. The unified-tree design adds
  no leakage relative to the per-asset baseline; it only widens the
  anonymity set during the in-pool phase.

**The tree never sees plaintext amounts either.** The commitment is
`Poseidon(amount, tokenId, owner, blinding)`, so the leaves don't
expose value any more than they expose token type. Two users who
deposit "the same amount of the same token" still produce different
commitments because of `blinding`, so there is no fingerprint that
clusters identical denominations across the pool.

### Implications consumers should know

- An attacker observing the chain cannot infer "address X holds N of
  token T" from the tree alone. They can only correlate timing —
  which is exactly why `transfer()` should be submitted via a relayer
  (see Q8).
- Aggregate liquidity reports per token are still possible by
  reading `Deposit` events (amount + token are public there) and
  `Withdrawal` events (recipient + amount + token public). These
  totals do not break privacy — they only show "the pool gained N of
  token T at time t" without identifying who.

---

## Q4 — `encryptedNote` is not validated on-chain

### Question
The `deposit()` and `transfer()` functions accept an `encryptedNote`
parameter and emit it verbatim in the event log without any check on
its format, length, or contents. Meanwhile the SDK's `scanForViewer`
trusts the decrypted plaintext and surfaces it as the user's note
balance. What is the contract's intended role here, and how is this
validated?

### Answer — contract layer cannot validate it; SDK layer must

The contract is fundamentally unable to validate the encrypted
content. The whole point of encryption is that the contract cannot
read it; if it could, every observer could, and the note metadata
(amount, token, blinding) would no longer be private. So the
on-chain side is deliberately a transparent passthrough.

The check has to happen client-side, where the viewing key lives. The
SDK's recovery flow already has all the inputs needed:

```
For each scanned (commitment, encryptedNote):
    plaintext = ECIES_decrypt(encryptedNote, viewingKey)
    if decrypt failed: continue          // not our note
    recomputed = Poseidon(
        plaintext.amount,
        plaintext.tokenId,
        ownerPubkey,              // derived from our spendingKey
        plaintext.blinding,
    )
    if recomputed != commitment: continue // attacker-forged plaintext
    push as our note
```

Without the `recomputed == commitment` check, an attacker can deposit
1 wei but craft an `encryptedNote` claiming `(amount = 1_000_000 ATOSHI,
…)` encrypted to a victim's viewing key. The victim's wallet would
decrypt the note successfully, treat it as 1M ATOSHI of balance, and
display fake holdings — until the victim tried to spend it, at which
point the proof would fail (the circuit re-hashes the same way and
discovers the mismatch). That window of false confidence is enough to
mislead a victim into OTC sales or collateralized lending against
phantom balance.

### Status
- **Contract:** no change required. The contract correctly does not
  attempt to validate cryptographically opaque payloads.
- **SDK / H5:** the validation lives in `recoverNotesFromChain` —
  see the matching commit in the SDK repo / H5 repo on the audit
  branch.

Reported by: audit 2026-06 — commit abd68f4, Q4.

---

## Q8 — `transfer()` and `withdraw()` reveal `msg.sender`

### Question
Per the technical-design document, the H5 wallet signs the
`Shield.transfer()` call with the user's MetaMask key. The contract
puts no restriction on `msg.sender`. That means every private
transfer publishes a record of "address X invoked Shield.transfer at
time t" to the L2 explorer, which links X to a privacy-pool operation
and lets observers cluster a user's deposits with their later
transfers / withdrawals. What's the intended submission flow?

### Answer — relayer-only submission, enforced off-chain

The contract layer cannot prevent `msg.sender` from leaking; any
EVM call records its sender on-chain by construction. The fix is
operational: the production submission path for `transfer()` and
`withdraw()` must go through a relayer service rather than the
user's own EOA.

### Submission flow

```
User's H5 wallet:
   ┌──────────────────────────────────────────────────────────┐
   │ 1. Generate Groth16 proof in browser (snarkjs)           │
   │ 2. POST {proof, publicSignals, encryptedNote} to relayer │
   │    over HTTPS — no EVM transaction, no MetaMask signature│
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
Relayer service (atoshi-privacy-relayer):
   ┌──────────────────────────────────────────────────────────┐
   │ 3. Receive request, validate proof shape, optionally     │
   │    sanity-check fee >= relayer's minimum                 │
   │ 4. Sign + submit the L2 tx with the relayer's own EOA    │
   │ 5. Relayer pays L2 gas; recoups via the `_fee` field     │
   │    that's baked into the proof (audit Issue 4 / circuit  │
   │    Issue 3 binding means it's safe — only this exact     │
   │    relayer address can claim the fee)                    │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
On-chain Shield contract:
   ┌──────────────────────────────────────────────────────────┐
   │ 6. msg.sender = relayer's EOA — never the user's EOA     │
   │ 7. Verify proof, mark nullifier spent, insert commitment │
   │    / pay recipient                                       │
   └──────────────────────────────────────────────────────────┘
```

The only call paths where the user's own EOA is the sender are:
- `deposit()`: unavoidable (the user must sign the ERC20 / native
  transfer that funds the pool — the deposit itself is publicly
  attributable).
- A `transfer()` or `withdraw()` deliberately self-paid for testing.

### Why this can't be encoded into the contract

A `require(msg.sender != tx.origin)` style check would only force the
user to deploy a forwarder contract, not actually decouple them from
the on-chain trail (the forwarder address still links to them). The
real defense is operational: the H5 product never builds a wallet-
signed transaction for `transfer()` / `withdraw()`, only an HTTP POST
to the relayer.

### Status

- **Contract:** no change in this commit. The relayer-binding work
  for `withdraw()` (audit Issue 4) is the cryptographic foundation —
  the relayer field is now part of the public-input vector, so once
  a user signs a proof for a specific relayer, no one else can hijack
  the fee.
- **SDK / H5:** future commit on the audit branch in the H5 repo
  removes the direct `writeContractAsync` call sites for
  `transfer()` / `withdraw()` and replaces them with a POST to the
  relayer.
- **Relayer service:** a new repo (`atoshi-privacy-relayer`) will
  host the HTTP service. Initial version: a single operator-run
  Node.js service. Mainnet may open a permissioned relayer registry.

Reported by: audit 2026-06 — commit abd68f4, Q8.
