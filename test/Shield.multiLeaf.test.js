// 关键回归测试：多 leaf 场景下的 Merkle tree.
//
// 历史：MerkleTree.sol 原本在 even-branch insert 时把 `right` 设为
// `filledSubtrees[i]`（旧 leaf 残留），而 Tornado-Cash 标准是 `zeros[i]`。
// 1 leaf 时碰巧没问题；2+ leaf 时 on-chain root 不对应任何标准 Merkle，
// 隐私功能完全失效。本测试覆盖该 corner case。
//
// 如果以后 MerkleTree.sol 再被改回旧逻辑，这个测试会立即失败。

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { poseidonContract, buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const CIRCUITS_ROOT = path.resolve(__dirname, "..", "..", "atoshi-privacy-circuits");
const UNSHIELD_WASM = path.join(CIRCUITS_ROOT, "build", "unshield", "unshield_js", "unshield.wasm");
const UNSHIELD_ZKEY = path.join(CIRCUITS_ROOT, "keys", "unshield_final.zkey");

const TREE_LEVELS = 20;
const NATIVE_TOKEN = ethers.ZeroAddress;

function randomField() {
  return BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
}

describe("Shield Merkle tree: 多 leaf 场景", function () {
  this.timeout(180_000);

  let owner, user1, user2, recipient, relayer;
  let shield;
  let poseidon, F;
  let zeros;

  before(function () {
    if (!fs.existsSync(UNSHIELD_WASM) || !fs.existsSync(UNSHIELD_ZKEY)) {
      this.skip();
    }
  });

  beforeEach(async function () {
    [owner, user1, user2, recipient, relayer] = await ethers.getSigners();

    poseidon = await buildPoseidon();
    F = poseidon.F;

    zeros = [0n];
    for (let i = 1; i < TREE_LEVELS; i++) {
      const prev = zeros[i - 1];
      zeros.push(F.toObject(poseidon([prev, prev])));
    }

    const poseidonAbi = poseidonContract.generateABI(2);
    const poseidonBytecode = poseidonContract.createCode(2);
    const poseidonFactory = new ethers.ContractFactory(poseidonAbi, poseidonBytecode, owner);
    const poseidonInst = await poseidonFactory.deploy();
    await poseidonInst.waitForDeployment();
    const poseidonAddr = await poseidonInst.getAddress();

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

    const Shield = await ethers.getContractFactory("Shield");
    shield = await Shield.deploy(
      await transferV.getAddress(),
      await unshieldV.getAddress(),
      poseidonAddr,
      owner.address,
    );
    await shield.waitForDeployment();
  });

  it("3 个 leaf 后的 on-chain root 与标准 Merkle tree 一致", async function () {
    // 插 3 个不同的 commitment
    const commitments = [randomField(), randomField(), randomField()];
    const amount = ethers.parseEther("1");
    for (const c of commitments) {
      await shield.connect(user1).deposit(c, NATIVE_TOKEN, amount, { value: amount });
    }

    // off-chain 按标准 Merkle 重建
    let level = commitments.slice();
    for (let lvl = 0; lvl < TREE_LEVELS; lvl++) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zeros[lvl];
        next.push(F.toObject(poseidon([left, right])));
      }
      level = next;
    }
    const expectedRoot = level[0];

    const onChainRoot = await shield.getLastRoot();
    expect(onChainRoot).to.equal(expectedRoot);
  });

  it("withdraw 第 2 笔 leaf (不是第 0 笔) 的 ZK proof 能通过链上验证", async function () {
    // 准备 3 个 Note
    const notes = [];
    for (let i = 0; i < 3; i++) {
      const privateKey = randomField();
      const blinding = randomField();
      const ownerPubKey = F.toObject(poseidon([privateKey]));
      const amount = ethers.parseEther("1");
      const tokenId = 0n;
      const commitment = F.toObject(
        poseidon([BigInt(amount.toString()), tokenId, ownerPubKey, blinding]),
      );
      notes.push({ privateKey, blinding, ownerPubKey, amount, tokenId, commitment });
    }

    // 全部 deposit
    for (const n of notes) {
      await shield.connect(user1).deposit(n.commitment, NATIVE_TOKEN, n.amount, { value: n.amount });
    }

    // 取第 1 笔（leafIndex=1）
    const target = notes[1];
    const leafIndex = 1n;

    // 算 nullifier
    const nullifierHash = F.toObject(
      poseidon([target.commitment, target.privateKey, leafIndex]),
    );

    // 按标准 Merkle 算法重建整棵树，每层保存所有节点（不存在的位置补 zeros[lvl]）
    // 然后为 leaf 1 查 path
    const allLeaves = notes.map((n) => n.commitment);
    const treeLevels = [allLeaves.slice()];
    for (let lvl = 0; lvl < TREE_LEVELS; lvl++) {
      const cur = treeLevels[lvl];
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        const left = cur[i];
        const right = i + 1 < cur.length ? cur[i + 1] : zeros[lvl];
        next.push(F.toObject(poseidon([left, right])));
      }
      treeLevels.push(next);
    }

    const pathElements = new Array(TREE_LEVELS);
    const pathIndices = new Array(TREE_LEVELS);
    let curIdx = Number(leafIndex);
    for (let lvl = 0; lvl < TREE_LEVELS; lvl++) {
      const isRight = curIdx & 1;
      const sibIdx = isRight ? curIdx - 1 : curIdx + 1;
      const level = treeLevels[lvl];
      const sibling = sibIdx < level.length ? level[sibIdx] : zeros[lvl];
      pathElements[lvl] = sibling.toString();
      pathIndices[lvl] = isRight;
      curIdx = curIdx >> 1;
    }

    const currentRoot = (await shield.getLastRoot()).toString();
    const input = {
      root: currentRoot,
      nullifierHash: nullifierHash.toString(),
      recipient: BigInt(recipient.address).toString(),
      tokenId: target.tokenId.toString(),
      amount: target.amount.toString(),
      fee: "0",
      privateKey: target.privateKey.toString(),
      blinding: target.blinding.toString(),
      leafIndex: leafIndex.toString(),
      pathElements,
      pathIndices,
    };
    const { proof } = await snarkjs.groth16.fullProve(input, UNSHIELD_WASM, UNSHIELD_ZKEY);
    const pA = [proof.pi_a[0], proof.pi_a[1]];
    const pB = [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ];
    const pC = [proof.pi_c[0], proof.pi_c[1]];

    // 应该不 revert
    await expect(
      shield.connect(relayer).withdraw(
        pA, pB, pC,
        currentRoot, nullifierHash, recipient.address, relayer.address, 0n,
        NATIVE_TOKEN, target.amount,
      ),
    ).to.emit(shield, "Withdrawal");

    expect(await shield.isSpent(nullifierHash)).to.equal(true);
  });
});
