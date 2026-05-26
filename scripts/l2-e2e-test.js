// ============================================================================
// L2 Testnet 端到端隐私交易验证脚本
// ============================================================================
//
// 目的：
//   验证 L2 上 *已经部署* 的 Shield + Verifier 合约，跑一遍完整的
//   "明文 → 隐私 → 明文" 流程 (Shield deposit → ZK proof → Unshield withdraw)，
//   确认你的 L2 部署没问题，安卓接入前的最后一道地基检查。
//
// 跟 test/Shield.e2e.test.js 的区别：
//   - 那个跑在 Hardhat 本地链，每次部署新合约
//   - 这个跑在 *真实的 L2 testnet (chain 67890)*，用 *已部署* 的合约
//   - 这个验证 "部署是否正确"，那个验证 "数学是否正确"
//
// 前置条件：
//   1. L2 sequencer 正常出块 (curl eth_blockNumber 是增长的)
//   2. 一个 L2 上 *已有 ATOS 余额* 的私钥（L2 genesis 预分配地址）
//   3. atoshi-privacy-circuits 里的 unshield.wasm + unshield_final.zkey 文件存在
//
// 使用：
//   cd atoshi-privacy-contracts
//   PRIVATE_KEY=0x<你L2上有余额的私钥> node scripts/l2-e2e-test.js
//
// 可选环境变量：
//   L2_RPC_URL      L2 RPC 地址，默认 http://52.76.210.218:8123
//   L2_CHAIN_ID     L2 chain id，默认 67890
//   SHIELD_ADDR     Shield 合约地址，默认按 PLAN.md 填好
//   AMOUNT_ATOS     测试金额（ATOS），默认 0.01 (避免把测试地址掏空)
//   RECIPIENT_ADDR  Unshield 接收方，默认 = PRIVATE_KEY 的地址
//   SKIP_FORK_GUARD 设为 "1" 跳过 fork11 dry-run 预检（不推荐）
//
// 重要：fork11 已知 bug — 任何 revert 的 tx 会 halt sequencer。
//      本脚本在每笔写交易前都先做 eth_call dry-run，revert 的不发送。
// ============================================================================

const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

// ---- 配置 ----
const L2_RPC_URL = process.env.L2_RPC_URL || "http://52.76.210.218:8123";
const L2_CHAIN_ID = Number(process.env.L2_CHAIN_ID || 67890);
const SHIELD_ADDR =
  process.env.SHIELD_ADDR || "0x81fAA0D0579c82d6b77FD759C198B507180E59E9";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AMOUNT_ATOS = process.env.AMOUNT_ATOS || "0.01";
const SKIP_FORK_GUARD = process.env.SKIP_FORK_GUARD === "1";

if (!PRIVATE_KEY) {
  console.error("ERROR: 必须设置 PRIVATE_KEY 环境变量");
  console.error("用法: PRIVATE_KEY=0x... node scripts/l2-e2e-test.js");
  process.exit(1);
}

const CIRCUITS_ROOT = path.resolve(__dirname, "..", "..", "atoshi-privacy-circuits");
const UNSHIELD_WASM = path.join(
  CIRCUITS_ROOT, "build", "unshield", "unshield_js", "unshield.wasm",
);
const UNSHIELD_ZKEY = path.join(CIRCUITS_ROOT, "keys", "unshield_final.zkey");

for (const p of [UNSHIELD_WASM, UNSHIELD_ZKEY]) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: 找不到 ZK 电路产物: ${p}`);
    console.error("先在 atoshi-privacy-circuits 里跑一次 npm run build");
    process.exit(1);
  }
}

// ---- 常量 ----
const TREE_LEVELS = 20;
const NATIVE_TOKEN = ethers.ZeroAddress;
const FIELD_SIZE = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

// Shield ABI（只列脚本用到的方法）
const SHIELD_ABI = [
  "function deposit(uint256 _commitment, address _token, uint256 _amount) external payable",
  "function withdraw(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256 _root, uint256 _nullifierHash, address _recipient, address _relayer, uint256 _fee, address _token, uint256 _amount) external",
  "function getLastRoot() external view returns (uint256)",
  "function getNextIndex() external view returns (uint32)",
  "function isSpent(uint256 _nullifierHash) external view returns (bool)",
  "function paused() external view returns (bool)",
  "function supportedTokens(address) external view returns (bool)",
  "function minDeposits(address) external view returns (uint256)",
  "event Deposit(uint256 indexed commitment, uint256 leafIndex, uint256 timestamp, address indexed token, uint256 amount)",
  "event Withdrawal(address indexed recipient, uint256 indexed nullifierHash, address indexed relayer, uint256 fee)",
];

// ---- 工具函数 ----
function log(stage, msg) {
  console.log(`\n\x1b[1;34m[${stage}]\x1b[0m ${msg}`);
}
function ok(msg)   { console.log(`  \x1b[1;32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\n\x1b[1;31m[FAIL]\x1b[0m ${msg}`); process.exit(1); }

function randomField() {
  // 31 字节随机 → 248 位 → 远小于 FIELD_SIZE，安全
  const bytes = ethers.randomBytes(31);
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

// fork11 dry-run 预检：先 eth_call 看会不会 revert，会就别发
// 用 provider.call() 而非 contract.staticCall()，确保 value 字段一定被传递
async function dryRunOrThrow(wallet, contract, methodName, args, overrides, label) {
  if (SKIP_FORK_GUARD) {
    console.log(`  (跳过 dry-run 预检: ${label})`);
    return;
  }
  try {
    const populated = await contract[methodName].populateTransaction(...args);
    const fromAddr = await wallet.getAddress();
    const callTx = {
      from: fromAddr,
      to: populated.to,
      data: populated.data,
      value: overrides && overrides.value ? overrides.value : 0n,
      gas: overrides && overrides.gasLimit ? overrides.gasLimit : undefined,
    };
    await wallet.provider.call(callTx);
  } catch (e) {
    const msg = e.shortMessage || e.message || String(e);
    const reason = e.reason || e.info?.error?.message || "";
    fail(
      `dry-run revert (${label})，拒绝提交以避免 sequencer halt:\n` +
      `  ${msg}` +
      (reason ? `\n  reason: ${reason}` : "") +
      `\n\n  如果你想强制提交（有 sequencer halt 风险），重跑时加 SKIP_FORK_GUARD=1`
    );
  }
}

// 等 tx receipt
async function sendAndWait(wallet, contract, methodName, args, overrides, label) {
  // 1. dry-run
  await dryRunOrThrow(wallet, contract, methodName, args, overrides, label);

  // 2. populate + 强制 Type 0 (legacy) tx，fork11 pool 只收这个
  const populated = await contract[methodName].populateTransaction(...args, overrides || {});
  populated.type = 0;
  delete populated.maxFeePerGas;
  delete populated.maxPriorityFeePerGas;
  if (!populated.gasPrice) {
    populated.gasPrice = await wallet.provider.getFeeData().then(d => d.gasPrice);
  }

  // 3. 发送 + 等 receipt
  const tx = await wallet.sendTransaction(populated);
  ok(`tx 已发送: ${tx.hash}`);
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) {
    fail(`tx 失败: ${tx.hash}`);
  }
  ok(`tx 已确认 block ${rcpt.blockNumber}，gasUsed=${rcpt.gasUsed}`);
  return rcpt;
}

// ============================================================================
// 主流程
// ============================================================================
async function main() {
  const startedAt = Date.now();

  // ---- 0. 连 RPC ----
  log("0/8", "连接 L2 RPC + 基础检查");
  const provider = new ethers.JsonRpcProvider(
    L2_RPC_URL,
    {
      chainId: L2_CHAIN_ID,
      name: "atoshi-l2",
    },
    {
      batchMaxCount: 1,        // fork11: 不支持 batch RPC
      staticNetwork: true,     // ethers 不要重复探测 chainId
    },
  );

  const blockNum = await provider.getBlockNumber();
  ok(`L2 当前块高: ${blockNum} (chain ${L2_CHAIN_ID})`);

  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const myAddr = await wallet.getAddress();
  const myBal = await provider.getBalance(myAddr);
  ok(`测试账户: ${myAddr}`);
  ok(`余额: ${ethers.formatEther(myBal)} ATOS`);

  if (myBal === 0n) {
    fail(`测试账户 L2 余额为 0。请用 L2 genesis 预分配过的私钥重试。`);
  }

  const recipientAddr = process.env.RECIPIENT_ADDR || myAddr;
  ok(`Unshield 接收方: ${recipientAddr}`);

  const amount = ethers.parseEther(AMOUNT_ATOS);
  ok(`测试金额: ${AMOUNT_ATOS} ATOS = ${amount} aatos`);

  if (myBal < amount * 2n) {
    fail(`余额不足 (${ethers.formatEther(myBal)} < 2x ${AMOUNT_ATOS})，需要至少 2 倍金额以覆盖 deposit + gas`);
  }

  // Shield 合约
  const shield = new ethers.Contract(SHIELD_ADDR, SHIELD_ABI, wallet);

  // 验证合约确实在链上
  const shieldCode = await provider.getCode(SHIELD_ADDR);
  if (shieldCode === "0x") {
    fail(`Shield 合约地址 ${SHIELD_ADDR} 上没有代码！部署有问题。`);
  }
  ok(`Shield 合约存在: ${SHIELD_ADDR}`);

  // ---- 1. Off-chain Poseidon + zeros[] 计算 ----
  log("1/8", "构造 off-chain Poseidon hasher + 计算 zeros[]");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const zeros = [0n];
  for (let i = 1; i < TREE_LEVELS; i++) {
    const prev = zeros[i - 1];
    zeros.push(F.toObject(poseidon([prev, prev])));
  }
  ok(`计算完毕：zeros[0]=0, zeros[19]=${zeros[19].toString(16).slice(0, 10)}...`);

  // ---- 2. Sanity check: on-chain root == off-chain zeros[19]（如果池子从没用过）----
  log("2/8", "Sanity check：on-chain root vs off-chain zeros[19]");
  const initialRoot = await shield.getLastRoot();
  const nextIndex = await shield.getNextIndex();
  ok(`on-chain root = ${initialRoot.toString(16).slice(0, 12)}...`);
  ok(`on-chain nextIndex = ${nextIndex}`);

  if (nextIndex === 0n) {
    if (initialRoot !== zeros[TREE_LEVELS - 1]) {
      fail(`池子是空的但根不匹配！off-chain zeros[19]=${zeros[19]} on-chain=${initialRoot}\n  这是 Poseidon 参数不一致的信号——必须修复，否则所有 proof 都会失败。`);
    }
    ok(`空池根匹配 ✓ Poseidon 参数对得上`);
  } else {
    ok(`池子已有 ${nextIndex} 笔历史 deposit，跳过空池根检查`);
  }

  // ---- 3. 生成 Note ----
  log("3/8", "生成新 Note (privateKey + blinding)");
  const privateKey = randomField();
  const blinding = randomField();
  const tokenId = 0n;
  const fee = 0n;

  const ownerPubKey = F.toObject(poseidon([privateKey]));
  const commitment = F.toObject(
    poseidon([BigInt(amount.toString()), tokenId, ownerPubKey, blinding]),
  );
  ok(`commitment = ${commitment.toString(16).slice(0, 16)}...`);
  if (commitment >= FIELD_SIZE) {
    fail(`commitment 超出 BN254 域大小`);
  }

  // ---- 4. Shield.deposit() ----
  log("4/8", `调 Shield.deposit() 存入 ${AMOUNT_ATOS} ATOS`);

  // Pre-flight: 把 deposit 的 3 个 require 单独查一遍，定位失败原因
  const isPaused = await shield.paused();
  const tokenSupported = await shield.supportedTokens(NATIVE_TOKEN);
  const minDep = await shield.minDeposits(NATIVE_TOKEN);
  ok(`合约状态: paused=${isPaused}, NATIVE 已注册=${tokenSupported}, minDeposit=${ethers.formatEther(minDep)} ATOS`);
  if (isPaused)        fail(`Shield 合约处于 paused 状态。owner 调 setPaused(false) 解除`);
  if (!tokenSupported) fail(`NATIVE_TOKEN 未注册。owner 调 addSupportedToken(0x0, minAmount)`);
  if (amount < minDep) fail(`金额 ${AMOUNT_ATOS} 小于 minDeposit ${ethers.formatEther(minDep)}。提高 AMOUNT_ATOS`);

  // 用 eth_estimateGas 让链自己告诉我们真实 gas 需求,然后乘以 1.5 倍 safety
  // deposit 内部会调 20 次链上 Poseidon (Merkle tree 20 层),消耗 600K-1M gas
  let depositGas;
  try {
    const populated = await shield.deposit.populateTransaction(commitment, NATIVE_TOKEN, amount);
    depositGas = await wallet.provider.estimateGas({
      from: myAddr,
      to: SHIELD_ADDR,
      data: populated.data,
      value: amount,
    });
    ok(`deposit 估算 gas = ${depositGas} (用 1.5x = ${depositGas * 15n / 10n})`);
  } catch (e) {
    fail(
      `eth_estimateGas 失败 — 说明 deposit 本身会 revert:\n  ${e.shortMessage || e.message}\n` +
      `这是业务逻辑 revert,不是 gas 不够。检查 commitment / msg.value / 合约状态。`
    );
  }
  const depositGasLimit = depositGas * 15n / 10n;
  const depositRcpt = await sendAndWait(
    wallet, shield, "deposit",
    [commitment, NATIVE_TOKEN, amount],
    { value: amount, gasLimit: depositGasLimit },
    "Shield.deposit",
  );

  // 先尝试从事件解析 leafIndex
  let leafIndex = null;
  for (const lg of depositRcpt.logs) {
    try {
      const parsed = shield.interface.parseLog(lg);
      if (parsed && parsed.name === "Deposit") {
        leafIndex = BigInt(parsed.args.leafIndex);
        break;
      }
    } catch (_) { /* not our event */ }
  }

  // 如果事件解析不出来,从 nextIndex 推导:
  // deposit 前 nextIndex=N, deposit 后 nextIndex=N+1, 这笔的 leafIndex = N
  if (leafIndex === null) {
    const newNextIndex = await shield.getNextIndex();
    leafIndex = BigInt(newNextIndex) - 1n;
    console.log(`  (事件解析失败,从 nextIndex 推导 leafIndex = ${leafIndex})`);
    // 调试: 打印 receipt 里所有 log 的 topics,方便后续修 ABI
    if (depositRcpt.logs.length > 0) {
      console.log(`  receipt 包含 ${depositRcpt.logs.length} 条 log:`);
      depositRcpt.logs.forEach((lg, i) => {
        console.log(`    [${i}] addr=${lg.address} topics[0]=${lg.topics[0]}`);
      });
    } else {
      console.log(`  receipt 里没有任何 log — fork11 mock 模式有时会丢 log`);
    }
  } else {
    ok(`Deposit 事件 leafIndex = ${leafIndex}`);
  }

  // 验证一致性
  const afterNextIndex = await shield.getNextIndex();
  ok(`deposit 后 nextIndex = ${afterNextIndex} (我的 leafIndex = ${leafIndex})`);

  // ---- 5. 构造 Merkle proof ----
  // 从链上拉所有 Deposit 事件,重建整棵 Merkle tree,给任意 leafIndex 算 proof
  log("5/8", "从链上拉 Deposit 事件 + 重建 Merkle tree");

  // Deposit 事件: Deposit(uint256 indexed commitment, uint256 leafIndex, uint256 timestamp, address indexed token, uint256 amount)
  const depositTopic = ethers.id("Deposit(uint256,uint256,uint256,address,uint256)");

  // L2 RPC 限制 eth_getLogs 单次最多 10000 块,分批拉
  const CHUNK = 9000;
  const latestBlock = await wallet.provider.getBlockNumber();
  const allDepositLogs = [];
  for (let from = 0; from <= latestBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latestBlock);
    const chunk = await wallet.provider.getLogs({
      address: SHIELD_ADDR,
      topics: [depositTopic],
      fromBlock: from,
      toBlock: to,
    });
    if (chunk.length > 0) {
      console.log(`  block ${from}-${to}: 找到 ${chunk.length} 笔`);
    }
    allDepositLogs.push(...chunk);
  }
  ok(`拉到 ${allDepositLogs.length} 笔历史 Deposit (扫了 ${latestBlock} 块)`);

  // 解析所有 leaf
  const depositIface = new ethers.Interface([
    "event Deposit(uint256 indexed commitment, uint256 leafIndex, uint256 timestamp, address indexed token, uint256 amount)",
  ]);
  const leaves = new Array(Number(afterNextIndex)).fill(null);
  for (const lg of allDepositLogs) {
    let parsed = null;
    try {
      parsed = depositIface.parseLog(lg);
    } catch (e) {
      console.log(`  无法解析 log: ${e.message}`);
      continue;
    }
    if (!parsed) continue;
    const idx = Number(parsed.args.leafIndex);
    leaves[idx] = BigInt(parsed.args.commitment);
  }

  // 检查所有 leaf 都解析出来了
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i] === null) {
      fail(`leaf[${i}] 没找到事件,无法重建 tree`);
    }
  }
  ok(`所有 ${leaves.length} 笔 leaf 解析完毕`);

  // 重建 Merkle tree
  // level[0] = leaves, level[i+1][j] = poseidon(level[i][2j], level[i][2j+1])
  // 空位用 zeros[i] 填
  let curLevel = leaves.slice();
  const treeLevels = []; // treeLevels[i] = 第 i 层的所有节点(已填补 zeros)
  treeLevels.push(curLevel.slice());

  for (let lvl = 0; lvl < TREE_LEVELS; lvl++) {
    const nextLevel = [];
    for (let i = 0; i < curLevel.length; i += 2) {
      const left = curLevel[i];
      const right = i + 1 < curLevel.length ? curLevel[i + 1] : zeros[lvl];
      nextLevel.push(F.toObject(poseidon([left, right])));
    }
    curLevel = nextLevel;
    treeLevels.push(curLevel.slice());
  }

  const computedRoot = curLevel[0];
  const onChainRootNow = await shield.getLastRoot();
  ok(`off-chain root = ${computedRoot.toString(16).slice(0, 16)}...`);
  ok(`on-chain  root = ${onChainRootNow.toString(16).slice(0, 16)}...`);
  if (computedRoot !== onChainRootNow) {
    fail(
      `重建的 root 与链上不一致!\n` +
      `  off-chain = ${computedRoot}\n` +
      `  on-chain  = ${onChainRootNow}\n` +
      `可能漏了 deposit 事件,或 Poseidon 参数不一致`
    );
  }
  ok(`Merkle root 一致 ✓ 链上链下完全同步`);

  // 给 my leafIndex 算 proof path
  const pathElements = [];
  const pathIndices = [];
  let idx = Number(leafIndex);
  for (let lvl = 0; lvl < TREE_LEVELS; lvl++) {
    const isRight = idx & 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const levelNodes = treeLevels[lvl];
    let sibling;
    if (siblingIdx < levelNodes.length) {
      sibling = levelNodes[siblingIdx];
    } else {
      sibling = zeros[lvl];
    }
    pathElements.push(sibling.toString());
    pathIndices.push(isRight);
    idx = idx >> 1;
  }
  ok(`pathElements 长度 ${pathElements.length}, pathIndices=[${pathIndices.slice(0, 5).join(",")},...]`);

  // ---- 6. 计算 nullifier + 生成 ZK proof ----
  log("6/8", "off-chain 生成 Groth16 proof (snarkjs)，耗时 1-3 秒");
  const nullifierHash = F.toObject(
    poseidon([commitment, privateKey, leafIndex]),
  );

  const currentRoot = (await shield.getLastRoot()).toString();
  const recipientUint = BigInt(recipientAddr);

  const input = {
    // public signals
    root: currentRoot,
    nullifierHash: nullifierHash.toString(),
    recipient: recipientUint.toString(),
    tokenId: tokenId.toString(),
    amount: amount.toString(),
    fee: fee.toString(),
    // private signals
    privateKey: privateKey.toString(),
    blinding: blinding.toString(),
    leafIndex: leafIndex.toString(),
    pathElements,
    pathIndices,
  };

  const proveStart = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input, UNSHIELD_WASM, UNSHIELD_ZKEY,
  );
  ok(`proof 生成完毕，耗时 ${Date.now() - proveStart}ms`);

  // 格式化（Groth16 G2 内层 swap，这是 snarkjs 输出和 Solidity 之间的常见约定）
  const pA = [proof.pi_a[0], proof.pi_a[1]];
  const pB = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const pC = [proof.pi_c[0], proof.pi_c[1]];

  // sanity: snarkjs 输出的 public signals 必须与输入一致
  if (publicSignals[0] !== input.root) {
    fail(`publicSignals[0] (root) 与输入不一致 — snarkjs 内部出错`);
  }
  if (publicSignals[1] !== nullifierHash.toString()) {
    fail(`publicSignals[1] (nullifierHash) 与输入不一致`);
  }
  ok(`proof public signals 校验通过`);

  // ---- 7. Shield.withdraw() ----
  log("7/8", `调 Shield.withdraw() 把 ${AMOUNT_ATOS} ATOS 取到 ${recipientAddr}`);

  const balBefore = await provider.getBalance(recipientAddr);
  ok(`recipient 取款前余额: ${ethers.formatEther(balBefore)} ATOS`);

  // withdraw 也 estimate gas (verifier proof check 也很贵)
  let withdrawGas;
  try {
    const populated = await shield.withdraw.populateTransaction(
      pA, pB, pC, currentRoot, nullifierHash, recipientAddr,
      ethers.ZeroAddress, fee, NATIVE_TOKEN, amount,
    );
    withdrawGas = await wallet.provider.estimateGas({
      from: myAddr,
      to: SHIELD_ADDR,
      data: populated.data,
    });
    ok(`withdraw 估算 gas = ${withdrawGas} (用 1.5x = ${withdrawGas * 15n / 10n})`);
  } catch (e) {
    fail(`withdraw estimateGas 失败 (业务 revert):\n  ${e.shortMessage || e.message}`);
  }

  await sendAndWait(
    wallet, shield, "withdraw",
    [
      pA, pB, pC,
      currentRoot, nullifierHash, recipientAddr,
      ethers.ZeroAddress,    // relayer (自付模式)
      fee,
      NATIVE_TOKEN, amount,
    ],
    { gasLimit: withdrawGas * 15n / 10n },
    "Shield.withdraw",
  );

  const balAfter = await provider.getBalance(recipientAddr);
  const delta = balAfter - balBefore;

  // 协议费默认 30 bps (0.3%)，预期收到 amount * 0.997
  const protocolFee = (amount * 30n) / 10000n;
  const expectedDelta = amount - fee - protocolFee;
  ok(`recipient 取款后余额: ${ethers.formatEther(balAfter)} ATOS`);
  ok(`实际到账: ${ethers.formatEther(delta)} ATOS`);
  ok(`预期到账: ${ethers.formatEther(expectedDelta)} ATOS (扣 0.3% 协议费)`);

  // 注意：如果 recipient == myAddr，余额还要减掉这笔 withdraw 的 gas，
  // 所以 delta 会比 expectedDelta 略小。这里用容忍判断。
  const recipientIsSelf = recipientAddr.toLowerCase() === myAddr.toLowerCase();
  if (recipientIsSelf) {
    if (delta < expectedDelta - ethers.parseEther("0.001")) {
      fail(`到账金额异常: ${delta} < ${expectedDelta} - gas`);
    }
  } else {
    if (delta !== expectedDelta) {
      fail(`到账金额不对: 实际 ${delta} ≠ 预期 ${expectedDelta}`);
    }
  }
  ok(`金额校验通过`);

  // ---- 8. 验证 nullifier 已被标记 ----
  log("8/8", "验证 nullifier 已被 Shield 合约标记为已花费");
  const spent = await shield.isSpent(nullifierHash);
  if (!spent) fail(`nullifier 应该被标记为 spent 但 isSpent 返回 false`);
  ok(`nullifier 已 spent ✓ 双花保护生效`);

  // ---- 总结 ----
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log(`\x1b[1;32m✓ L2 testnet 隐私功能端到端验证通过\x1b[0m  总耗时 ${elapsed}s`);
  console.log("=".repeat(60));
  console.log("  • Shield 合约链上部署 ✓");
  console.log("  • Poseidon 参数链上链下一致 ✓");
  console.log("  • Shield.deposit ✓");
  console.log("  • snarkjs ZK proof 生成 ✓");
  console.log("  • Shield.withdraw + UnshieldVerifier 验证 ✓");
  console.log("  • 双花保护 ✓");
  console.log("");
  console.log("  → 隐私功能在 L2 testnet 生产环境验证通过，可以让安卓团队接入。");
  console.log("");
}

main().catch((e) => {
  console.error("\n\x1b[1;31mFATAL:\x1b[0m", e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
