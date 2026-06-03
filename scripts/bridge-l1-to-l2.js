// L1 → L2 桥测试 (auto-claim 验证)
//
// Usage:
//   PRIVATE_KEY=<L1 sender私钥> RECEIVER=0x... AMOUNT=1 node scripts/bridge-l1-to-l2.js
//
// 在 L1 上调 bridgeAsset, 然后轮询 L2 余额, 验证 ClaimTxManager 自动 claim 工作.
// fork11: Type 0 (legacy) tx.

const { ethers } = require("ethers");

const L1_BRIDGE  = "0xC241A13b93b3969e15303c194520Fc2f950F7F4b";
const DEST_NETWORK_L2 = 1;     // 0=L1, 1=L2

const BRIDGE_ABI = [
  "function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable",
];

async function main() {
  const L1_RPC_URL  = process.env.L1_RPC_URL  || "http://178.238.226.45:8545";
  const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID || 88288);
  const L2_RPC_URL  = process.env.L2_RPC_URL  || "http://52.76.210.218:8123";
  const L2_CHAIN_ID = Number(process.env.L2_CHAIN_ID || 67890);
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const RECEIVER    = process.env.RECEIVER;
  const AMOUNT_ATOS = process.env.AMOUNT || "1";

  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required");
  if (!RECEIVER)    throw new Error("RECEIVER env required");

  const l1 = new ethers.JsonRpcProvider(L1_RPC_URL, { chainId: L1_CHAIN_ID, name: "atoshi-l1" }, { batchMaxCount: 1, staticNetwork: true });
  const l2 = new ethers.JsonRpcProvider(L2_RPC_URL, { chainId: L2_CHAIN_ID, name: "atoshi-l2" }, { batchMaxCount: 1, staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, l1);
  const from = await wallet.getAddress();
  const amount = ethers.parseEther(AMOUNT_ATOS);

  const l1Bal = await l1.getBalance(from);
  const l2BalBefore = await l2.getBalance(RECEIVER);
  console.log(`Sender (L1):       ${from}`);
  console.log(`L1 余额:           ${ethers.formatEther(l1Bal)} ATOS`);
  console.log(`Receiver (L2):     ${RECEIVER}`);
  console.log(`L2 余额 (桥前):    ${ethers.formatEther(l2BalBefore)} ATOSHI`);
  console.log(`桥金额:            ${AMOUNT_ATOS} ATOS\n`);

  const bridge = new ethers.Contract(L1_BRIDGE, BRIDGE_ABI, wallet);
  const tx = await bridge.bridgeAsset(
    DEST_NETWORK_L2,
    RECEIVER,
    amount,
    ethers.ZeroAddress,
    true,
    "0x",
    { value: amount, type: 0, gasLimit: 500_000n, gasPrice: ethers.parseUnits("2", "gwei") }
  );
  console.log(`→ L1 bridge tx: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`✓ L1 block ${rcpt.blockNumber}, status ${rcpt.status === 1 ? "OK" : "FAIL"}\n`);

  console.log("等待 ClaimTxManager 自动 claim (轮询 L2 余额, 最多 5 分钟)…");
  for (let i = 1; i <= 30; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    const balNow = await l2.getBalance(RECEIVER);
    if (balNow > l2BalBefore) {
      const delta = balNow - l2BalBefore;
      console.log(`\n✓ Auto-claim 成功! L2 +${ethers.formatEther(delta)} ATOSHI  (等待 ${i * 10}s)`);
      console.log(`L2 余额 (桥后): ${ethers.formatEther(balNow)} ATOSHI`);
      return;
    }
    process.stdout.write(`.${i % 6 === 0 ? `[${i * 10}s]` : ""}`);
  }
  console.error("\n✗ 超时: 5 分钟内 L2 余额未变化. 检查 docker logs zkevm-bridge-service.");
  process.exit(2);
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
