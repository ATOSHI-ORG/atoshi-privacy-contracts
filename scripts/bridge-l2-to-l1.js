// L2 → L1 桥测试
//
// Usage:
//   PRIVATE_KEY=<L2 sender私钥> RECEIVER=0x... AMOUNT=1 node scripts/bridge-l2-to-l1.js
//
// 在 L2 上调 bridgeAsset, 然后轮询 L1 余额.
// 注意: L2→L1 需要等 L2 batch 被 sequence → aggregate → verified on L1,
// 通常 10-30 分钟 (取决于你的 aggregator 频率).
// fork11: Type 0 (legacy) tx.

const { ethers } = require("ethers");

const L2_BRIDGE  = "0x0101481FA81E3044934CD905d322f4F5f116cc55";
const DEST_NETWORK_L1 = 0;

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
  const wallet = new ethers.Wallet(PRIVATE_KEY, l2);
  const from = await wallet.getAddress();
  const amount = ethers.parseEther(AMOUNT_ATOS);

  const l2Bal = await l2.getBalance(from);
  const l1BalBefore = await l1.getBalance(RECEIVER);
  console.log(`Sender (L2):       ${from}`);
  console.log(`L2 余额:           ${ethers.formatEther(l2Bal)} ATOSHI`);
  console.log(`Receiver (L1):     ${RECEIVER}`);
  console.log(`L1 余额 (桥前):    ${ethers.formatEther(l1BalBefore)} ATOS`);
  console.log(`桥金额:            ${AMOUNT_ATOS} ATOSHI\n`);

  const bridge = new ethers.Contract(L2_BRIDGE, BRIDGE_ABI, wallet);
  const tx = await bridge.bridgeAsset(
    DEST_NETWORK_L1,
    RECEIVER,
    amount,
    ethers.ZeroAddress,
    true,
    "0x",
    { value: amount, type: 0, gasLimit: 500_000n, gasPrice: ethers.parseUnits("2", "gwei") }
  );
  console.log(`→ L2 bridge tx: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`✓ L2 block ${rcpt.blockNumber}, status ${rcpt.status === 1 ? "OK" : "FAIL"}\n`);

  console.log("等待 L2 batch verified 上 L1 + auto-claim (最多 30 分钟)…");
  for (let i = 1; i <= 90; i++) {
    await new Promise(r => setTimeout(r, 20_000));
    const balNow = await l1.getBalance(RECEIVER);
    if (balNow > l1BalBefore) {
      const delta = balNow - l1BalBefore;
      console.log(`\n✓ Auto-claim 成功! L1 +${ethers.formatEther(delta)} ATOS  (等待 ${i * 20}s)`);
      console.log(`L1 余额 (桥后): ${ethers.formatEther(balNow)} ATOS`);
      return;
    }
    process.stdout.write(`.${i % 6 === 0 ? `[${i * 20}s]` : ""}`);
  }
  console.error("\n✗ 超时: 30 分钟内 L1 余额未变化. 检查 aggregator 是否在产 proof.");
  process.exit(2);
}

main().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
