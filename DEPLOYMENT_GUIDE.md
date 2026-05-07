# Atoshi Privacy Contracts 部署指南

## 📋 合约架构说明

### 核心合约（必须部署）

1. **Verifier.sol** - ZK-SNARK 证明验证器
   - 作用：验证零知识证明的有效性
   - 依赖：无
   
2. **Shield.sol** - 隐私池主合约
   - 作用：管理存款、取款、隐私转账
   - 依赖：Verifier, MerkleTree, Poseidon
   
3. **TokenRegistry.sol** - 代币注册表
   - 作用：管理支持的代币列表和配置
   - 依赖：无

### 库合约（自动链接）

- **MerkleTree.sol** - Merkle 树实现
- **Poseidon.sol** - Poseidon 哈希函数

### 测试合约（不部署到生产环境）

- **MockERC20.sol** - 测试用 ERC20 代币

---

## 🔧 编译错误修复

### 问题：类型转换错误

```
TypeError: Explicit type conversion not allowed from "address payable" to "uint160".
```

### 解决方案

已在代码中添加 `addressToUint256()` 辅助函数来处理类型转换。

如果编译仍然失败，请手动执行以下步骤：

```bash
# 1. 彻底清理缓存
cd /Users/liudongqi/atoshi/atoshi-privacy-contracts
rm -rf cache artifacts node_modules/.hardhat node_modules/.cache

# 2. 清理 Hardhat
npx hardhat clean

# 3. 重新编译
npx hardhat compile --force
```

---

## 🚀 部署步骤

### 步骤 1: 确认环境配置

检查 `.env` 文件：

```bash
cat .env
```

应该包含：
```
L2_RPC_URL=http://54.169.30.130:8123
PRIVATE_KEY=3B7955D25189C99A7468192FCBC6429205C158834053EBE3F78F4512AB432DB9
```

### 步骤 2: 检查账户余额

```bash
npx hardhat run scripts/check-balance.js --network atoshi_l2
```

### 步骤 3: 编译合约

```bash
npx hardhat compile
```

### 步骤 4: 部署合约

```bash
npx hardhat run scripts/deploy.js --network atoshi_l2
```

---

## 📝 部署后配置

### 1. 保存合约地址

部署成功后，合约地址会保存在：
```
deployments/atoshi_l2.json
```

### 2. 更新前端配置

将合约地址复制到前端配置文件：
```bash
# 查看部署地址
cat deployments/atoshi_l2.json

# 更新前端 .env.local
cd ../../shield
nano .env.local
```

添加：
```
VITE_VERIFIER_ADDRESS=<Verifier地址>
VITE_TOKEN_REGISTRY_ADDRESS=<TokenRegistry地址>
VITE_SHIELD_ADDRESS=<Shield地址>
VITE_L2_RPC_URL=http://54.169.30.130:8123
VITE_L2_CHAIN_ID=67890
```

---

## 🔍 验证部署

### 检查合约是否部署成功

```bash
# 检查 Verifier
cast code <VERIFIER_ADDRESS> --rpc-url http://54.169.30.130:8123

# 检查 Shield
cast code <SHIELD_ADDRESS> --rpc-url http://54.169.30.130:8123

# 检查 TokenRegistry
cast code <TOKEN_REGISTRY_ADDRESS> --rpc-url http://54.169.30.130:8123
```

### 测试合约交互

```bash
npx hardhat run scripts/test-deployment.js --network atoshi_l2
```

---

## ❓ 常见问题

### Q1: 编译一直报错怎么办？

A: 尝试以下步骤：
1. 删除 `node_modules` 重新安装：`rm -rf node_modules && npm install`
2. 使用兼容的 Node.js 版本（推荐 v18 或 v20）
3. 检查 Solidity 版本是否为 0.8.24

### Q2: 部署时 gas 不足？

A: 检查账户余额：
```bash
cast balance 0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9 --rpc-url http://54.169.30.130:8123
```

### Q3: 私钥对应的地址是什么？

A: 私钥 `3B7955D25189C99A7468192FCBC6429205C158834053EBE3F78F4512AB432DB9` 对应的地址应该是 genesis.json 中的 deployer 地址 `0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9`

---

## 📞 需要帮助？

如果遇到问题，请提供：
1. 完整的错误信息
2. 使用的命令
3. 当前的网络配置

---

## 🔁 Step 2：升级到 3-Verifier 架构后重新部署

> 适用范围：在隐私交易优化里把单一占位 `Verifier.sol` 替换成 snarkjs
> 自动生成的 `ShieldVerifier` / `TransferVerifier` / `UnshieldVerifier`
> 之后，必须**重新部署**整套合约才能生效。已有的 L2 部署
> （`deployments/atoshi_l2.json` 里的旧地址）作废，因为旧 Shield
> 用的是旧构造函数签名。

### 必读：跟旧版的差异

| 项 | 旧版（占位） | 新版（snarkjs 生成） |
|---|---|---|
| 验证器合约数量 | 1 个 (`Groth16Verifier`) | **3 个**（每个电路一个） |
| Shield 构造函数 | `(verifier, feeRecipient)` | `(transferVerifier, unshieldVerifier, feeRecipient)` |
| `verifyProof` 第 4 参数 | `uint256[]`（动态） | `uint256[N]` 固定大小（N=1/3/6） |
| 链上是否真的能验真实证明 | ❌ 不行（常量是占位符） | ✅ 行 |

### 前置条件

L2 链已经起来，能从你部署机器访问到：

```bash
# 1. 在 atoshi-privacy-contracts 目录下创建 .env
cat > .env <<EOF
L2_RPC_URL=http://<your-l2-rpc>:8123
L2_CHAIN_ID=67890
PRIVATE_KEY=0x<deployer-private-key>
EOF

# 2. 测试 RPC 通：
curl -X POST $L2_RPC_URL \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# 应返回 0x10892 (= 67890 hex) 或你设置的 chain id
```

### 部署

```bash
cd /Users/liudongqi/atoshi/atoshi-privacy-contracts

# 1. 清旧编译产物，重新编译
npx hardhat clean
npx hardhat compile
# 期望输出：Compiled 5 Solidity files successfully

# 2. 自动跑全套部署（包含编译 + 检查 + 部署）
./deploy-to-l2.sh

# 或者手动跑（更可控）：
node scripts/deploy-direct.js
```

部署脚本会按顺序部署 5 个合约：

```
1/5  ShieldVerifier      (1 public signal)
2/5  TransferVerifier    (3 public signals)
3/5  UnshieldVerifier    (6 public signals)
4/5  TokenRegistry
5/5  Shield               ← 构造函数收前两个 verifier 地址
```

部署成功后会写 `deployments/atoshi_l2.json`，例如：

```json
{
  "network": "atoshi_l2",
  "chainId": 67890,
  "rpcUrl": "http://...:8123",
  "deployer": "0x...",
  "timestamp": "2026-...",
  "contracts": {
    "ShieldVerifier":   "0x...",
    "TransferVerifier": "0x...",
    "UnshieldVerifier": "0x...",
    "TokenRegistry":    "0x...",
    "Shield":           "0x..."
  }
}
```

### 部署后必做的 3 件事

1. **更新 SDK 配置**：把上面 5 个地址写进
   `atoshi-privacy-sdk/src/config/index.ts` 的对应字段
   （`shieldContract`、`transferVerifier`、`unshieldVerifier` 等）

2. **更新前端 `.env`**：DApp 用的合约地址要同步更新

3. **跑 e2e 验证**（关键！）：用 SDK 真的发一笔 deposit → 拿
   Merkle proof → 生成 ZK proof → 调 Shield.withdraw，确认
   verifyProof 链上返回 true。验证器换成真实的之后**这是第一次
   能跑通的端到端 ZK 闭环**——任何配置错（地址错、artifact 错版本）
   都会在这步暴露。

### 回退方案

如果新部署有问题，旧 `Shield` 合约还在链上（地址在 git 历史里的
`deployments/atoshi_l2.json`），但**无法处理任何真实 ZK 证明**——
所以"回退"的唯一意义是保留旧测试数据。生产应用直接用新地址。

### 删除旧的占位合约

新部署上线、e2e 跑通至少 24h 后，可以安全删除：

```bash
git rm contracts/core/Verifier.sol
# 同时删掉 artifacts/contracts/core/Verifier.sol/ 缓存
git commit -m "chore: remove orphaned Verifier.sol placeholder"
```

