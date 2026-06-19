const { expect } = require("chai");
const { ethers } = require("hardhat");
const { poseidonContract } = require("circomlibjs");

// Dummy Groth16 proof. All zeros; only valid against MockVerifiers
// (which ignore the proof bytes and just return their `result` flag).
// Real-proof end-to-end is covered separately in Shield.e2e.test.js.
const ZERO_PROOF = {
  pA: [0n, 0n],
  pB: [[0n, 0n], [0n, 0n]],
  pC: [0n, 0n],
};

describe("Shield Contract", function () {
  let shield;
  let shieldVerifier;
  let transferVerifier;
  let unshieldVerifier;
  let poseidon;
  let mockToken;
  let owner;
  let user1;
  let user2;
  let relayer;

  const NATIVE_TOKEN = ethers.ZeroAddress;
  const FIELD_SIZE = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");

  beforeEach(async function () {
    [owner, user1, user2, relayer] = await ethers.getSigners();

    // Deploy MockVerifiers for all three circuits. The unit-test suite
    // doesn't generate real ZK proofs (too slow), so we replace each
    // auto-generated Groth16 verifier with a mock that always returns
    // true. The single full-stack proof flow is exercised separately
    // in Shield.e2e.test.js with the real verifiers + keys.
    const ShieldV = await ethers.getContractFactory("MockShieldVerifier");
    shieldVerifier = await ShieldV.deploy();
    await shieldVerifier.waitForDeployment();

    const TransferV = await ethers.getContractFactory("MockTransferVerifier");
    transferVerifier = await TransferV.deploy();
    await transferVerifier.waitForDeployment();

    const UnshieldV = await ethers.getContractFactory("MockUnshieldVerifier");
    unshieldVerifier = await UnshieldV.deploy();
    await unshieldVerifier.waitForDeployment();

    // Deploy real Poseidon(2) from circomlibjs bytecode. The contract's
    // Merkle tree must hash with the same Poseidon as the off-chain
    // circuit, so any Solidity-side keccak placeholder would produce
    // incompatible hashes.
    const poseidonAbi = poseidonContract.generateABI(2);
    const poseidonBytecode = poseidonContract.createCode(2);
    const poseidonFactory = new ethers.ContractFactory(poseidonAbi, poseidonBytecode, owner);
    poseidon = await poseidonFactory.deploy();
    await poseidon.waitForDeployment();

    // Deploy Shield. Constructor signature after audit Issue 2:
    //   (shieldVerifier, transferVerifier, unshieldVerifier, poseidon, feeRecipient)
    const Shield = await ethers.getContractFactory("Shield");
    shield = await Shield.deploy(
      await shieldVerifier.getAddress(),
      await transferVerifier.getAddress(),
      await unshieldVerifier.getAddress(),
      await poseidon.getAddress(),
      owner.address, // feeRecipient
    );
    await shield.waitForDeployment();

    // Deploy mock ERC20 token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK", 18);
    await mockToken.waitForDeployment();

    // Add mock token to supported tokens
    await shield.addSupportedToken(await mockToken.getAddress(), ethers.parseEther("0.01"));

    // Mint tokens to user1
    await mockToken.mint(user1.address, ethers.parseEther("1000"));
  });

  describe("Deployment", function () {
    it("Should set the correct shield + transfer + unshield verifiers", async function () {
      expect(await shield.shieldVerifier()).to.equal(await shieldVerifier.getAddress());
      expect(await shield.transferVerifier()).to.equal(await transferVerifier.getAddress());
      expect(await shield.unshieldVerifier()).to.equal(await unshieldVerifier.getAddress());
    });

    it("Should set the correct owner", async function () {
      expect(await shield.owner()).to.equal(owner.address);
    });

    it("Should support native token by default", async function () {
      expect(await shield.supportedTokens(NATIVE_TOKEN)).to.be.true;
    });

    it("Should initialize Merkle tree", async function () {
      expect(await shield.getNextIndex()).to.equal(0);
    });
  });

  describe("Deposit - Native Token", function () {
    it("Should accept native token deposits", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("1");

      // Use `anyValue` for the timestamp arg — hardhat's block timestamp
      // doesn't always advance by exactly 1 between getBlock("latest")
      // and the deposit tx, especially when other beforeEach steps
      // (verifier deploys, etc.) burn blocks of their own. Asserting the
      // commitment / leafIndex / token / amount / encryptedNote is
      // enough; the timestamp is just block metadata.
      const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount })
      )
        .to.emit(shield, "Deposit")
        .withArgs(commitment, 0, anyValue, NATIVE_TOKEN, amount, "0x");

      expect(await shield.getNextIndex()).to.equal(1);
    });

    it("Should reject deposit with incorrect native amount", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("1");

      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: ethers.parseEther("0.5") })
      ).to.be.revertedWith("Shield: incorrect native amount");
    });

    it("Should reject commitment >= FIELD_SIZE", async function () {
      const invalidCommitment = FIELD_SIZE + BigInt(1);
      const amount = ethers.parseEther("1");

      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, invalidCommitment, NATIVE_TOKEN, amount, "0x", { value: amount })
      ).to.be.revertedWith("Shield: invalid commitment");
    });
  });

  describe("Deposit - ERC20 Token", function () {
    it("Should accept ERC20 token deposits", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("100");
      const tokenAddress = await mockToken.getAddress();

      // Approve Shield contract
      await mockToken.connect(user1).approve(await shield.getAddress(), amount);

      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, tokenAddress, amount, "0x")
      )
        .to.emit(shield, "Deposit");

      expect(await mockToken.balanceOf(await shield.getAddress())).to.equal(amount);
    });

    it("Should reject unsupported token", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("100");
      const fakeToken = user2.address; // Random address

      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, fakeToken, amount, "0x")
      ).to.be.revertedWith("Shield: unsupported token");
    });
  });

  describe("Multiple Deposits", function () {
    it("Should handle multiple deposits correctly", async function () {
      const amount = ethers.parseEther("1");

      for (let i = 0; i < 5; i++) {
        const commitment = BigInt(i + 1) * BigInt("1000000000000000000");
        await shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount });
      }

      expect(await shield.getNextIndex()).to.equal(5);
    });

    it("Should update Merkle root after each deposit", async function () {
      const amount = ethers.parseEther("1");
      const roots = [];

      for (let i = 0; i < 3; i++) {
        const commitment = BigInt(i + 1) * BigInt("1000000000000000000");
        await shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount });
        roots.push(await shield.getLastRoot());
      }

      // Each deposit should produce a different root
      expect(roots[0]).to.not.equal(roots[1]);
      expect(roots[1]).to.not.equal(roots[2]);
    });
  });

  describe("Nullifier Management", function () {
    it("Should track spent nullifiers", async function () {
      const nullifierHash = BigInt("9876543210987654321");
      
      // Initially not spent
      expect(await shield.isSpent(nullifierHash)).to.be.false;
    });
  });

  describe("Root History", function () {
    it("Should recognize known roots", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("1");

      await shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount });
      
      const root = await shield.getLastRoot();
      expect(await shield.isKnownRoot(root)).to.be.true;
    });

    it("Should reject unknown roots", async function () {
      const fakeRoot = BigInt("999999999999999999");
      expect(await shield.isKnownRoot(fakeRoot)).to.be.false;
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to add supported token", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const newToken = await MockERC20.deploy("New Token", "NEW", 18);
      await newToken.waitForDeployment();

      await shield.addSupportedToken(await newToken.getAddress(), ethers.parseEther("0.1"));
      expect(await shield.supportedTokens(await newToken.getAddress())).to.be.true;
    });

    it("Should allow owner to remove supported token", async function () {
      const tokenAddress = await mockToken.getAddress();
      await shield.removeSupportedToken(tokenAddress);
      expect(await shield.supportedTokens(tokenAddress)).to.be.false;
    });

    it("Should allow owner to update shield + transfer + unshield verifiers", async function () {
      // Re-key one verifier at a time (e.g. after a Phase 2 ceremony only
      // re-runs one circuit). Use user2.address as a placeholder; the
      // contract just stores the address.
      const newAddr = user2.address;
      await shield.setShieldVerifier(newAddr);
      expect(await shield.shieldVerifier()).to.equal(newAddr);
      await shield.setTransferVerifier(newAddr);
      expect(await shield.transferVerifier()).to.equal(newAddr);
      await shield.setUnshieldVerifier(newAddr);
      expect(await shield.unshieldVerifier()).to.equal(newAddr);
    });

    it("Should allow owner to set protocol fee", async function () {
      await shield.setProtocolFee(50); // 0.5%
      expect(await shield.protocolFeeBps()).to.equal(50);
    });

    it("Should reject fee > 10%", async function () {
      await expect(shield.setProtocolFee(1001)).to.be.revertedWith("Shield: fee too high");
    });

    it("Should allow owner to pause/unpause", async function () {
      await shield.setPaused(true);
      expect(await shield.paused()).to.be.true;

      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("1");

      await expect(
        shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount })
      ).to.be.revertedWith("Shield: paused");

      await shield.setPaused(false);
      expect(await shield.paused()).to.be.false;
    });

    it("Should reject non-owner admin calls", async function () {
      await expect(
        shield.connect(user1).addSupportedToken(user2.address, 0)
      ).to.be.revertedWithCustomError(shield, "OwnableUnauthorizedAccount");
    });
  });

  describe("Gas Usage", function () {
    it("Should measure deposit gas", async function () {
      const commitment = BigInt("12345678901234567890");
      const amount = ethers.parseEther("1");

      const tx = await shield.connect(user1).deposit(ZERO_PROOF.pA, ZERO_PROOF.pB, ZERO_PROOF.pC, commitment, NATIVE_TOKEN, amount, "0x", { value: amount });
      const receipt = await tx.wait();

      console.log(`    Deposit gas used: ${receipt.gasUsed.toString()}`);
      // 32-level Merkle insertion runs Poseidon(2) at every level. Real
      // Poseidon costs roughly 30-40k gas per call, pushing deposit gas
      // to ~1.3M after the depth bump (was ~700k at depth 20). Cap at
      // 1.5M as a regression guard; if this trips it means we
      // accidentally re-enabled an even heavier hash or doubled the
      // work somewhere. (Audit Issue 7 raised depth from 20 → 32.)
      expect(receipt.gasUsed).to.be.lessThan(1_500_000n);
    });
  });
});

