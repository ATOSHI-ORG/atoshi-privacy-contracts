// ============================================================================
// 只重新部署 Shield 合约（复用已存在的 Verifier + Poseidon）
// ============================================================================
//
// 触发：2026-05-27 发现 MerkleTree.sol bug,旧 Shield 多 leaf 时 root 不对应
//      标准 Merkle tree。bug 已修(zeros[i] 替代 filledSubtrees[i]),
//      但旧 Shield 已部署+池子里有垃圾 leaf,必须换地址重新部署。
//
// 用法：
//   cd atoshi-privacy-contracts
//   npx hardhat compile          # 必须先编(库变了,Shield 字节码也变了)
//   PRIVATE_KEY=0x... node scripts/redeploy-shield.js
//
// 部署完会：
//   1. addSupportedToken(NATIVE_TOKEN, 0)  — 注册原生 ATOS
//   2. 打印新 Shield 地址
//   3. 提示如何更新文档 / 跑 e2e 验证
//
// 已部署且复用的地址(从 PLAN.md)：
//   TransferVerifier: 0x14B3743E87d75786Ce350cAF26e1F719Ae5c0825
//   UnshieldVerifier: 0xa7944803e80B93952e9421622A4aBf75E77B5D17
//   Poseidon:         0xC1d3Bb5B7b9f4f097e7cD0126608D498A2986DAe
// ============================================================================

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ---- 已部署的合约地址(复用) ----
const TRANSFER_VERIFIER = "0x14B3743E87d75786Ce350cAF26e1F719Ae5c0825";
const UNSHIELD_VERIFIER = "0xa7944803e80B93952e9421622A4aBf75E77B5D17";
const POSEIDON          = "0xC1d3Bb5B7b9f4f097e7cD0126608D498A2986DAe";

async function main() {
  console.log("=".repeat(60));
  console.log("Atoshi L2  Shield 合约重新部署 (MerkleTree.sol bug fix)");
  console.log("=".repeat(60));

  const L2_RPC_URL  = process.env.L2_RPC_URL  || "http://52.76.210.218:8123";
  const L2_CHAIN_ID = Number(process.env.L2_CHAIN_ID || 67890);
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env var required");

  // fork11 quirks
  const provider = new ethers.JsonRpcProvider(
    L2_RPC_URL,
    { chainId: L2_CHAIN_ID, name: "atoshi-l2" },
    { batchMaxCount: 1, staticNetwork: true },
  );
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const myAddr = await wallet.getAddress();

  const bal = await provider.getBalance(myAddr);
  console.log(`Deployer:    ${myAddr}`);
  console.log(`L2 余额:     ${ethers.formatEther(bal)} ATOS`);
  if (bal === 0n) throw new Error("L2 余额为 0");

  // ---- 加载 Shield artifact ----
  const artifactPath = path.join(
    __dirname, "..", "artifacts", "contracts", "core", "Shield.sol", "Shield.json",
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Shield artifact 不存在: ${artifactPath}\n先跑 npx hardhat compile`);
  }
  const shieldArtifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  // ---- 确认 Verifier + Poseidon 都还在链上 ----
  for (const [name, addr] of [
    ["TransferVerifier", TRANSFER_VERIFIER],
    ["UnshieldVerifier", UNSHIELD_VERIFIER],
    ["Poseidon",         POSEIDON],
  ]) {
    const code = await provider.getCode(addr);
    if (code === "0x") throw new Error(`${name} 在 ${addr} 没有 code!`);
    console.log(`✓ ${name.padEnd(18)} ${addr}  (${code.length / 2 - 1} bytes)`);
  }

  // ---- 部署 Shield ----
  console.log("\n→ 部署新 Shield...");
  const ShieldFactory = new ethers.ContractFactory(
    shieldArtifact.abi, shieldArtifact.bytecode, wallet,
  );

  let nonce = await provider.getTransactionCount(myAddr);
  const txOpts = {
    nonce: nonce++,
    gasLimit: 6_000_000,    // Shield 部署 + _initializeZeros 走 20 次链上 Poseidon
    gasPrice: ethers.parseUnits("2", "gwei"),
    type: 0,                 // fork11 only legacy
  };

  const shield = await ShieldFactory.deploy(
    TRANSFER_VERIFIER,
    UNSHIELD_VERIFIER,
    POSEIDON,
    myAddr,                  // feeRecipient = deployer (上线前换 multisig)
    txOpts,
  );
  console.log(`  部署 tx: ${shield.deploymentTransaction().hash}`);
  await shield.waitForDeployment();
  const shieldAddr = await shield.getAddress();
  console.log(`✓ Shield 新地址:    ${shieldAddr}`);

  // ---- addSupportedToken(NATIVE_TOKEN, 0) ----
  console.log("\n→ 注册 NATIVE_TOKEN (constructor 里已默认开启,这一步是兜底)...");
  const isNative = await shield.supportedTokens(ethers.ZeroAddress);
  if (isNative) {
    console.log("  NATIVE_TOKEN 已开启,跳过");
  } else {
    const tx = await shield.addSupportedToken(ethers.ZeroAddress, 0, {
      nonce: nonce++,
      gasLimit: 100_000,
      gasPrice: ethers.parseUnits("2", "gwei"),
      type: 0,
    });
    await tx.wait();
    console.log(`  addSupportedToken 完成: ${tx.hash}`);
  }

  // ---- 简单 sanity check ----
  console.log("\n→ Sanity check...");
  const lastRoot   = await shield.getLastRoot();
  const nextIndex  = await shield.getNextIndex();
  const paused     = await shield.paused();
  console.log(`  getLastRoot():  ${lastRoot.toString(16).slice(0, 20)}...`);
  console.log(`  getNextIndex(): ${nextIndex}`);
  console.log(`  paused():       ${paused}`);
  if (nextIndex !== 0n) throw new Error("新合约 nextIndex 应该是 0!");

  // ---- 总结 ----
  console.log("\n" + "=".repeat(60));
  console.log("\x1b[1;32m✓ Shield 重新部署成功\x1b[0m");
  console.log("=".repeat(60));
  console.log(`新 Shield 地址: ${shieldAddr}`);
  console.log("");
  console.log("接下来要做:");
  console.log(`  1. 测试: SHIELD_ADDR=${shieldAddr} \\`);
  console.log(`           PRIVATE_KEY=$PRIVATE_KEY \\`);
  console.log(`           node scripts/l2-e2e-test.js`);
  console.log("");
  console.log("  2. 更新文档里的 SHIELD_ADDR (旧地址 0x81fAA0D0...):");
  console.log("     - /Users/liudongqi/atoshi/PLAN.md");
  console.log("     - /Users/liudongqi/atoshi/ATOSHI_API_接入指南.md");
  console.log("");
}

main().catch((e) => {
  console.error("\nFATAL:", e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
