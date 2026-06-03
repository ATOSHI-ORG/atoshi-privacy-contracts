// L1 上简单转账 (sender → 测试地址)
//
// Usage:
//   PRIVATE_KEY=<sender私钥> TO=0x... AMOUNT=10 node scripts/l1-send.js
//
// fork11 兼容: Type 0 (legacy) tx, batchMaxCount: 1

const { ethers } = require("ethers");

async function main() {
  const L1_RPC_URL  = process.env.L1_RPC_URL  || "http://178.238.226.45:8545";
  const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID || 88288);
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const TO          = process.env.TO;
  const AMOUNT_ATOS = process.env.AMOUNT || "10";

  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY env required");
  if (!TO) throw new Error("TO env required");

  const provider = new ethers.JsonRpcProvider(
    L1_RPC_URL,
    { chainId: L1_CHAIN_ID, name: "atoshi-l1" },
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
    chainId: L1_CHAIN_ID,
  };

  const sent = await wallet.sendTransaction(tx);
  console.log(`\n→ tx: ${sent.hash}`);
  const rcpt = await sent.wait();
  console.log(`✓ block ${rcpt.blockNumber}, status ${rcpt.status === 1 ? "OK" : "FAIL"}`);

  const toBal = await provider.getBalance(TO);
  console.log(`\n收款方现余额: ${ethers.formatEther(toBal)} ATOS`);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
