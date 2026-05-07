// Deploy the Atoshi privacy stack to L2 (or any EVM-compatible chain).
// Updated for the 3-verifier architecture: each circuit has its own
// auto-generated Solidity verifier (snarkjs zkey export solidityverifier).
//
// Required env vars:
//   PRIVATE_KEY    Hex private key of the deployer account.
//   L2_RPC_URL     RPC endpoint of the target chain. Defaults to the
//                  current L2 sequencer; UPDATE before running.
//   L2_CHAIN_ID    Numeric chain id. Defaults to 67890.
//
// Run with:
//   PRIVATE_KEY=0x... L2_RPC_URL=http://... node scripts/deploy-direct.js
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("部署隐私合约到 Atoshi L2");
  console.log("");

  // TODO: when L2 is redeployed on production hardware, change the
  //       default RPC below or pass L2_RPC_URL via env. The IP is left
  //       in code only as a developer hint.
  const L2_RPC_URL = process.env.L2_RPC_URL || "http://52.76.210.218:8123";
  const L2_CHAIN_ID = parseInt(process.env.L2_CHAIN_ID || "67890", 10);
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY env var is required (hex, 0x-prefixed)");
  }

  console.log("L2 RPC URL:", L2_RPC_URL);
  console.log("L2 Chain ID:", L2_CHAIN_ID);

  const provider = new ethers.JsonRpcProvider(L2_RPC_URL, L2_CHAIN_ID, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("部署账户:", wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log("账户余额:", ethers.formatEther(balance), "ETH");
  console.log("");

  // Load artifacts. Run `npx hardhat compile` first if these files
  // don't exist or are stale.
  function loadArtifact(rel) {
    const p = path.join(__dirname, "..", "artifacts", "contracts", rel);
    if (!fs.existsSync(p)) {
      throw new Error(`Artifact not found: ${p}\nRun \`npx hardhat compile\` first.`);
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  console.log("加载合约 artifacts...");
  const shieldVerifierArtifact   = loadArtifact("verifiers/ShieldVerifier.sol/ShieldVerifier.json");
  const transferVerifierArtifact = loadArtifact("verifiers/TransferVerifier.sol/TransferVerifier.json");
  const unshieldVerifierArtifact = loadArtifact("verifiers/UnshieldVerifier.sol/UnshieldVerifier.json");
  const tokenRegistryArtifact    = loadArtifact("tokens/TokenRegistry.sol/TokenRegistry.json");
  const shieldArtifact           = loadArtifact("core/Shield.sol/Shield.json");
  console.log("Artifacts 加载完成");
  console.log("");

  let nonce = await provider.getTransactionCount(wallet.address);
  const gasPrice = ethers.parseUnits("1", "gwei");
  const txOpts = (gasLimit) => ({ nonce: nonce++, gasLimit, gasPrice, type: 0 });

  // ============== Verifiers ==============
  // Shield verifier (1 public signal: commitment) — currently NOT
  // wired into Shield.sol because deposit() doesn't enforce a ZK proof.
  // Deployed anyway so the address is on record for future use (e.g.
  // when we add proof-of-correct-commitment to deposit).
  console.log("1/5  部署 ShieldVerifier...");
  const shieldVerifier = await new ethers.ContractFactory(
    shieldVerifierArtifact.abi, shieldVerifierArtifact.bytecode, wallet,
  ).deploy(txOpts(3_000_000));
  await shieldVerifier.waitForDeployment();
  const shieldVerifierAddress = await shieldVerifier.getAddress();
  console.log("   ShieldVerifier:   ", shieldVerifierAddress);

  console.log("2/5  部署 TransferVerifier...");
  const transferVerifier = await new ethers.ContractFactory(
    transferVerifierArtifact.abi, transferVerifierArtifact.bytecode, wallet,
  ).deploy(txOpts(3_000_000));
  await transferVerifier.waitForDeployment();
  const transferVerifierAddress = await transferVerifier.getAddress();
  console.log("   TransferVerifier: ", transferVerifierAddress);

  console.log("3/5  部署 UnshieldVerifier...");
  const unshieldVerifier = await new ethers.ContractFactory(
    unshieldVerifierArtifact.abi, unshieldVerifierArtifact.bytecode, wallet,
  ).deploy(txOpts(3_000_000));
  await unshieldVerifier.waitForDeployment();
  const unshieldVerifierAddress = await unshieldVerifier.getAddress();
  console.log("   UnshieldVerifier: ", unshieldVerifierAddress);
  console.log("");

  // ============== TokenRegistry ==============
  console.log("4/5  部署 TokenRegistry...");
  const tokenRegistry = await new ethers.ContractFactory(
    tokenRegistryArtifact.abi, tokenRegistryArtifact.bytecode, wallet,
  ).deploy(txOpts(3_000_000));
  await tokenRegistry.waitForDeployment();
  const tokenRegistryAddress = await tokenRegistry.getAddress();
  console.log("   TokenRegistry:    ", tokenRegistryAddress);
  console.log("");

  // ============== Shield ==============
  // Constructor signature changed: now takes (transferVerifier,
  // unshieldVerifier, feeRecipient).
  console.log("5/5  部署 Shield...");
  const shield = await new ethers.ContractFactory(
    shieldArtifact.abi, shieldArtifact.bytecode, wallet,
  ).deploy(
    transferVerifierAddress,
    unshieldVerifierAddress,
    wallet.address, // feeRecipient = deployer for now; change post-deploy
    txOpts(8_000_000),
  );
  await shield.waitForDeployment();
  const shieldAddress = await shield.getAddress();
  console.log("   Shield:           ", shieldAddress);
  console.log("");

  const deploymentInfo = {
    network: "atoshi_l2",
    chainId: L2_CHAIN_ID,
    rpcUrl: L2_RPC_URL,
    deployer: wallet.address,
    timestamp: new Date().toISOString(),
    contracts: {
      ShieldVerifier:   shieldVerifierAddress,
      TransferVerifier: transferVerifierAddress,
      UnshieldVerifier: unshieldVerifierAddress,
      TokenRegistry:    tokenRegistryAddress,
      Shield:           shieldAddress,
    },
  };

  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync("./deployments/atoshi_l2.json", JSON.stringify(deploymentInfo, null, 2));

  console.log("============================================================");
  console.log("部署完成！");
  console.log("============================================================");
  console.log("ShieldVerifier:   ", shieldVerifierAddress);
  console.log("TransferVerifier: ", transferVerifierAddress);
  console.log("UnshieldVerifier: ", unshieldVerifierAddress);
  console.log("TokenRegistry:    ", tokenRegistryAddress);
  console.log("Shield:           ", shieldAddress);
  console.log("============================================================");
  console.log("");
  console.log("部署信息已保存: deployments/atoshi_l2.json");
  console.log("");
  console.log("Next: update atoshi-privacy-sdk/src/config/index.ts with these addresses");
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("");
  console.error("部署失败:");
  console.error(error);
  process.exit(1);
});
