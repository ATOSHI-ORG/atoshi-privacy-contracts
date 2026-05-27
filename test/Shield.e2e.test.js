// End-to-end test for the Shield privacy pool.
//
// This is the first test that drives the FULL ZK flow:
//   1. Deploy real Poseidon + 3 verifiers + Shield
//   2. Generate a Note (privateKey, blinding, amount, tokenId)
//   3. Compute commitment off-chain with circomlibjs Poseidon
//   4. shield.deposit(commitment, ...) on-chain
//   5. Build a Merkle proof for the deposited leaf (off-chain mirror
//      of the on-chain tree; index=0 means all-zero siblings)
//   6. snarkjs.groth16.fullProve against unshield.wasm + unshield.zkey
//   7. shield.withdraw(...) — on-chain Verifier returns true
//   8. Recipient receives the net amount (gross - fee - protocol fee)
//
// Why this matters: every previous test stubbed verification. After the
// Step 0a (real verifiers) and Step 0b (real Poseidon) commits, this is
// the first time we can prove on-chain that the entire stack is
// consistent — circuit ↔ snarkjs ↔ Verifier ↔ MerkleTree. If this test
// passes, the L2 redeploy is safe to do; if it fails, something between
// off-chain Poseidon and on-chain hashing is still misaligned.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { poseidonContract, buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

// Circuit artifacts produced by `npx snarkjs zkey export solidityverifier`
// and the circuit compilation. Paths are relative to atoshi-privacy-circuits.
const CIRCUITS_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "atoshi-privacy-circuits",
);
const UNSHIELD_WASM = path.join(
  CIRCUITS_ROOT, "build", "unshield", "unshield_js", "unshield.wasm",
);
const UNSHIELD_ZKEY = path.join(CIRCUITS_ROOT, "keys", "unshield_final.zkey");

const TREE_LEVELS = 20;
const NATIVE_TOKEN = ethers.ZeroAddress;
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

// Random field element. Should be < FIELD_SIZE; rejection sampling not
// strictly required when using Math.random + 30 bytes (probability of
// >FIELD_SIZE is astronomically small for our test purposes).
function randomField() {
  const bytes = ethers.randomBytes(31); // 248 bits, well under field size
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

// Pad a number to 32-byte hex for snarkjs.
const toBigInt = (x) => (typeof x === "bigint" ? x : BigInt(x.toString()));

describe("Shield e2e: deposit -> ZK proof -> withdraw", function () {
  // ZK proof generation is slow (1-3s per proof on a laptop).
  this.timeout(120_000);

  let owner, user1, recipient, relayer;
  let shield;
  let poseidonContractAddr;
  let poseidon; // circomlibjs Poseidon (off-chain hasher matching the circuit)
  let F; // poseidon field

  // Pre-computed zero subtree hashes that match what Shield._initializeZeros
  // populates on-chain. zeros[i+1] = poseidon(zeros[i], zeros[i]).
  let zeros = [];

  // Skip cleanly when the circuit artifacts are missing (e.g. fresh
  // checkout that hasn't compiled circuits yet) so this test never blocks
  // unrelated CI runs.
  before(function () {
    if (!fs.existsSync(UNSHIELD_WASM) || !fs.existsSync(UNSHIELD_ZKEY)) {
      this.skip();
    }
  });

  beforeEach(async function () {
    [owner, user1, recipient, relayer] = await ethers.getSigners();

    // Off-chain Poseidon (circomlibjs).
    poseidon = await buildPoseidon();
    F = poseidon.F;

    // Compute zeros[0..19] off-chain to mirror Shield._initializeZeros.
    zeros = [0n];
    for (let i = 1; i < TREE_LEVELS; i++) {
      const prev = zeros[i - 1];
      zeros.push(F.toObject(poseidon([prev, prev])));
    }

    // Deploy real Poseidon(2).
    const poseidonAbi = poseidonContract.generateABI(2);
    const poseidonBytecode = poseidonContract.createCode(2);
    const poseidonFactory = new ethers.ContractFactory(
      poseidonAbi, poseidonBytecode, owner,
    );
    const poseidonInst = await poseidonFactory.deploy();
    await poseidonInst.waitForDeployment();
    poseidonContractAddr = await poseidonInst.getAddress();

    // Deploy verifiers (fully qualified to dodge legacy Verifier.sol shells).
    const TransferV = await ethers.getContractFactory(
      "contracts/verifiers/TransferVerifier.sol:TransferVerifier",
    );
    const transferV = await TransferV.deploy();
    await transferV.waitForDeployment();

    const UnshieldV = await ethers.getContractFactory(
      "contracts/verifiers/UnshieldVerifier.sol:UnshieldVerifier",
    );
    const unshieldV = await UnshieldV.deploy();
    await unshieldV.waitForDeployment();

    // Deploy Shield with all wiring.
    const Shield = await ethers.getContractFactory("Shield");
    shield = await Shield.deploy(
      await transferV.getAddress(),
      await unshieldV.getAddress(),
      poseidonContractAddr,
      owner.address, // feeRecipient
    );
    await shield.waitForDeployment();
  });

  it("commits an off-chain root that matches the on-chain root", async function () {
    // Sanity: with no leaves inserted, both off-chain zeros[19] and
    // on-chain getRoot() must agree. If they don't, every downstream proof
    // will fail isKnownRoot. This test catches Poseidon mismatches before
    // we burn 3 seconds generating a ZK proof.
    const onChainRoot = await shield.getLastRoot();
    expect(onChainRoot).to.equal(zeros[TREE_LEVELS - 1]);
  });

  it("accepts a deposit and exposes the new root", async function () {
    // Use a random commitment value — Shield doesn't enforce its
    // structure on deposit, only on withdraw via ZK proof.
    const commitment = randomField();
    const amount = ethers.parseEther("1");

    await expect(
      shield.connect(user1).deposit(commitment, NATIVE_TOKEN, amount, "0x", {
        value: amount,
      }),
    )
      .to.emit(shield, "Deposit")
      .withArgs(commitment, 0n, anyUint(), NATIVE_TOKEN, amount, "0x");

    expect(await shield.getNextIndex()).to.equal(1);

    // Off-chain mirror: with our commitment at leaf 0 and zeros[i] as
    // every right sibling, root = pathHash(commitment, zeros[0..19]).
    let cur = commitment;
    for (let i = 0; i < TREE_LEVELS; i++) {
      cur = F.toObject(poseidon([cur, zeros[i]]));
    }
    const onChainRoot = await shield.getLastRoot();
    expect(onChainRoot).to.equal(cur);
  });

  it("full ZK flow: deposit, prove ownership, withdraw", async function () {
    // ---- 1. Generate Note ----
    const privateKey = randomField();
    const blinding = randomField();
    const amount = ethers.parseEther("1");
    const fee = 0n; // no relayer fee in this happy-path test
    const tokenId = 0n; // NATIVE_TOKEN -> address(0) -> uint256 0

    // owner = Poseidon1(privateKey) — matches DerivePublicKey() in circuit
    const ownerPubKey = F.toObject(poseidon([privateKey]));

    // commitment = Poseidon4(amount, tokenId, owner, blinding)
    const commitment = F.toObject(
      poseidon([toBigInt(amount), tokenId, ownerPubKey, blinding]),
    );

    // ---- 2. Deposit ----
    await shield.connect(user1).deposit(commitment, NATIVE_TOKEN, amount, "0x", {
      value: amount,
    });
    const leafIndex = 0n; // first leaf

    // ---- 3. Build Merkle proof off-chain ----
    // leafIndex=0 means we are the LEFT child at every level; every right
    // sibling is the empty subtree zero.
    const pathElements = zeros.slice(0, TREE_LEVELS).map((z) => z.toString());
    const pathIndices = new Array(TREE_LEVELS).fill(0);

    // ---- 4. nullifierHash = Poseidon3(commitment, privateKey, leafIndex) ----
    const nullifierHash = F.toObject(
      poseidon([commitment, privateKey, leafIndex]),
    );

    // ---- 5. Generate ZK proof ----
    const recipientUint = BigInt(recipient.address);
    const input = {
      // public
      root: (await shield.getLastRoot()).toString(),
      nullifierHash: nullifierHash.toString(),
      recipient: recipientUint.toString(),
      tokenId: tokenId.toString(),
      amount: amount.toString(),
      fee: fee.toString(),
      // private
      privateKey: privateKey.toString(),
      blinding: blinding.toString(),
      leafIndex: leafIndex.toString(),
      pathElements,
      pathIndices,
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, UNSHIELD_WASM, UNSHIELD_ZKEY,
    );

    // ---- 6. Format proof for Solidity (Groth16 G2 has a swap) ----
    const pA = [proof.pi_a[0], proof.pi_a[1]];
    const pB = [
      [proof.pi_b[0][1], proof.pi_b[0][0]], // intentional inner swap
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ];
    const pC = [proof.pi_c[0], proof.pi_c[1]];

    // ---- 7. Sanity: pubSignals from snarkjs match our inputs ----
    expect(publicSignals.length).to.equal(6);
    expect(publicSignals[0]).to.equal(input.root);
    expect(publicSignals[1]).to.equal(nullifierHash.toString());

    // ---- 8. Withdraw on-chain ----
    const before = await ethers.provider.getBalance(recipient.address);
    await shield.connect(relayer).withdraw(
      pA, pB, pC,
      input.root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee,
      NATIVE_TOKEN,
      amount,
    );
    const after = await ethers.provider.getBalance(recipient.address);

    // Default protocol fee = 0.3% (30 bps). Net to recipient =
    // amount * (1 - 0.003) - fee. With fee=0 and amount=1 ETH that's
    // exactly 0.997 ETH.
    const protocolFee = (amount * 30n) / 10000n;
    const expectedDelta = amount - fee - protocolFee;
    expect(after - before).to.equal(expectedDelta);

    // Nullifier marked spent.
    expect(await shield.isSpent(nullifierHash)).to.equal(true);
  });
});

// ethers v6 lacks chai-matchers' anyValue for emit assertions. This is
// a small shim that returns true for any uint argument.
function anyUint() {
  return (val) => typeof val === "bigint" || typeof val === "number";
}
