// L2 上简单转账 (deployer → 测试地址)
//
// 用法:
//   PRIVATE_KEY=<deployer私钥> TO=0x144... AMOUNT=100 node scripts/l2-send.js
//
// 默认转 100 ATOS 到 0x144A98a791610bA7EeB902a7616EA352195B8c3D
//
// fork11 注意: Type 0 (legacy) tx, batchMaxCount: 1

const { ethers } = require("ethers");

async function main() {
  const L2_RPC_URL  = process.env.L2_RPC_URL  || "http://52.76.210.218:8123";
  const L2_CHAIN_ID = Number(process.env.L2_CHAIN_ID || 67890);
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const TO          = process.env.TO     || "0x144A98a791610bA7EeB902a7616EA352195B8c3D";
  const AMOUNT_ATOS = process.env.AMOUNT || "100";

  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required");

  const provider = new ethers.JsonRpcProvider(
    L2_RPC_URL,
    { chainId: L2_CHAIN_ID, name: "atoshi-l2" },
    { batchMaxCount: 1, staticNetwork: true },
  );
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const from = await wallet.getAddress();

  const balBefore = await provider.getBalance(from);
  console.log(`From:   ${from}`);
  console.log(`Bal:    ${ethers.formatEther(balBefore)} ATOS`);
  console.log(`To:     ${TO}`);
  console.log(`Amount: ${AMOUNT_ATOS} ATOS`);

  const value = ethers.parseEther(AMOUNT_ATOS);
  if (balBefore < value) throw new Error("余额不足");

  const nonce = await provider.getTransactionCount(from);
  const tx = {
    type: 0,
    nonce,
    to: TO,
    value,
    gasLimit: 21000n,
    gasPrice: ethers.parseUnits("2", "gwei"),
    chainId: L2_CHAIN_ID,
  };

  const sent = await wallet.sendTransaction(tx);
  console.log(`\n→ tx: ${sent.hash}`);
  const rcpt = await sent.wait();
  console.log(`✓ block ${rcpt.blockNumber}, status ${rcpt.status === 1 ? "OK" : "FAIL"}`);

  const toBal = await provider.getBalance(TO);
  console.log(`\n收款方现余额: ${ethers.formatEther(toBal)} ATOS`);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
