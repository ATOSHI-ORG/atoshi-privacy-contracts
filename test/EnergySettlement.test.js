// Unit tests for EnergySettlement.sol — quota accounting only,
// no ZK proofs involved. Shield's interaction is exercised here
// indirectly by impersonating the Shield address with hardhat's
// `setBalance` + `impersonateAccount`.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("EnergySettlement", function () {
  let owner, relayer, alice, bob, fakeShield;
  let settlement;

  beforeEach(async function () {
    [owner, relayer, alice, bob] = await ethers.getSigners();

    const F = await ethers.getContractFactory("EnergySettlement");
    settlement = await F.deploy();
    await settlement.waitForDeployment();

    // Impersonate an EOA we'll point Shield-side calls from.
    fakeShield = await ethers.getImpersonatedSigner(
      "0x0000000000000000000000000000000000099999",
    );
    await network.provider.send("hardhat_setBalance", [
      await fakeShield.getAddress(),
      "0x1000000000000000",
    ]);
    await settlement.connect(owner).setShield(await fakeShield.getAddress());
  });

  describe("registry", function () {
    it("registers + reports availability", async function () {
      await settlement.connect(owner).registerRelayer(relayer.address, 1_000_000n, 0); // default window
      expect(await settlement.isRegistered(relayer.address)).to.equal(true);
      expect(await settlement.availableQuota(relayer.address)).to.equal(1_000_000n);
    });

    it("rejects zero address / zero capacity", async function () {
      await expect(
        settlement.connect(owner).registerRelayer(ethers.ZeroAddress, 1n, 0),
      ).to.be.revertedWith("EnergySettlement: zero relayer");
      await expect(
        settlement.connect(owner).registerRelayer(relayer.address, 0n, 0),
      ).to.be.revertedWith("EnergySettlement: zero capacity");
    });

    it("only owner can register", async function () {
      await expect(
        settlement.connect(alice).registerRelayer(relayer.address, 1n, 0),
      ).to.be.reverted;
    });

    it("setRelayerCapacity bumps without resetting consumed", async function () {
      await settlement.connect(owner).registerRelayer(relayer.address, 1_000_000n, 0);
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 200_000n);
      await settlement.connect(owner).setRelayerCapacity(relayer.address, 5_000_000n);
      // Consumed stays at 200k, available grows to 4.8M.
      expect(await settlement.availableQuota(relayer.address)).to.equal(4_800_000n);
    });

    it("removeRelayer wipes the record", async function () {
      await settlement.connect(owner).registerRelayer(relayer.address, 1_000_000n, 0);
      await settlement.connect(owner).removeRelayer(relayer.address);
      expect(await settlement.isRegistered(relayer.address)).to.equal(false);
      expect(await settlement.availableQuota(relayer.address)).to.equal(0n);
    });
  });

  describe("consumption", function () {
    beforeEach(async function () {
      await settlement.connect(owner).registerRelayer(
        relayer.address, 1_000_000n, 60n,  // 1M cap, 60s window for fast tests
      );
    });

    it("only Shield (configured address) can consume", async function () {
      await expect(
        settlement.connect(alice).consumeForRelayer(relayer.address, 1n),
      ).to.be.revertedWith("EnergySettlement: not shield");
    });

    it("draws down available quota", async function () {
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 250_000n);
      expect(await settlement.availableQuota(relayer.address)).to.equal(750_000n);
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 250_000n);
      expect(await settlement.availableQuota(relayer.address)).to.equal(500_000n);
    });

    it("reverts when quota is exhausted", async function () {
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 999_000n);
      await expect(
        settlement.connect(fakeShield).consumeForRelayer(relayer.address, 2_000n),
      ).to.be.revertedWith("EnergySettlement: quota exhausted");
    });

    it("auto-resets after the window elapses", async function () {
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 800_000n);
      // Advance >60s.
      await network.provider.send("evm_increaseTime", [70]);
      await network.provider.send("evm_mine");
      // availableQuota view sees the elapsed window and reports full capacity.
      expect(await settlement.availableQuota(relayer.address)).to.equal(1_000_000n);
      // First consume in the new window also resets the counter on-chain.
      await settlement.connect(fakeShield).consumeForRelayer(relayer.address, 100n);
      expect(await settlement.availableQuota(relayer.address)).to.equal(999_900n);
    });

    it("rejects unregistered relayer", async function () {
      await expect(
        settlement.connect(fakeShield).consumeForRelayer(bob.address, 1n),
      ).to.be.revertedWith("EnergySettlement: relayer not registered");
    });
  });

  describe("setShield", function () {
    it("can be set to address(0) to pause consumption", async function () {
      await settlement.connect(owner).registerRelayer(relayer.address, 1_000_000n, 0);
      await settlement.connect(owner).setShield(ethers.ZeroAddress);
      // The previously authorised fakeShield no longer matches.
      await expect(
        settlement.connect(fakeShield).consumeForRelayer(relayer.address, 1n),
      ).to.be.revertedWith("EnergySettlement: not shield");
    });
  });
});
