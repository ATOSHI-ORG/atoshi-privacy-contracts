#!/bin/bash
set -e

echo "🚀 Atoshi Privacy Contracts - L2 部署脚本"
echo "=========================================="
echo ""

# 检查是否在正确的目录
if [ ! -f "hardhat.config.js" ]; then
  echo "❌ 错误：请在 atoshi-privacy-contracts 目录下运行此脚本"
  exit 1
fi

# 检查 .env 文件 / 环境变量
if [ -f ".env" ]; then
  set -a; source .env; set +a
fi

if [ -z "$L2_RPC_URL" ] || [ -z "$PRIVATE_KEY" ]; then
  echo "❌ 错误：缺少 L2_RPC_URL 或 PRIVATE_KEY"
  echo ""
  echo "请创建 .env 文件，例如："
  echo "  L2_RPC_URL=http://<your-l2-rpc>:8123"
  echo "  L2_CHAIN_ID=67890"
  echo "  PRIVATE_KEY=0x..."
  exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
  echo "📦 安装依赖..."
  npm install
fi

# 测试 L2 连接
echo "🔍 测试 L2 连接 ($L2_RPC_URL)..."
CHAIN_ID=$(curl -s -X POST "$L2_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -o '"result":"[^"]*"' | cut -d'"' -f4)

if [ -z "$CHAIN_ID" ]; then
  echo "❌ 无法连接到 L2 RPC"
  exit 1
fi

echo "✅ L2 连接成功，Chain ID: $CHAIN_ID"
echo ""

# 清理旧的编译文件
echo "🧹 清理旧的编译文件..."
npm run clean

# 编译合约
echo "🔨 编译合约..."
npm run compile

if [ $? -ne 0 ]; then
  echo "❌ 合约编译失败"
  exit 1
fi

echo "✅ 合约编译成功"
echo ""

# 部署合约
echo "🚀 部署合约到 L2..."
echo "   ShieldVerifier (1 pub signal)"
echo "   TransferVerifier (3 pub signals)"
echo "   UnshieldVerifier (6 pub signals)"
echo "   TokenRegistry"
echo "   Shield (constructor: transferVerifier, unshieldVerifier, feeRecipient)"
echo ""
node scripts/deploy-direct.js

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 合约部署失败"
  exit 1
fi

echo ""
echo "=========================================="
echo "✅ 部署完成！"
echo ""
echo "📋 下一步："
echo "1. 查看 deployments/atoshi_l2.json 获取合约地址"
echo "2. 更新 SDK 配置 (atoshi-privacy-sdk/src/config/index.ts)"
echo "3. 更新前端 .env (DApp 用的合约地址)"
echo "4. 跑 e2e 测试: deposit -> proof -> withdraw"
echo ""

