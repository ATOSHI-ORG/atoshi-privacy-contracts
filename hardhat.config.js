require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const ATOSHI_TESTNET_RPC = process.env.ATOSHI_TESTNET_RPC || "http://localhost:8545";
const ATOSHI_MAINNET_RPC = process.env.ATOSHI_MAINNET_RPC || "http://localhost:8545";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      // Solidity 0.8.20+ defaults to "shanghai" EVM, which emits PUSH0
      // (0x5f) opcode in contract bytecode. Polygon zkEVM fork11
      // executor doesn't recognize PUSH0 — calls to any function that
      // executes a PUSH0 instruction revert with "EvmError: Revert"
      // and no revert reason data, which is exactly the symptom we saw
      // on Shield.deposit().
      //
      // "paris" is the EVM version immediately before Shanghai, which
      // is the last spec without PUSH0. Compiling with this target
      // emits PUSH1 0 (0x6000) instead of PUSH0, costing 1 extra byte
      // per zero push but staying compatible with fork11.
      //
      // When upgrading to fork12+ this can be removed (fork12 added
      // PUSH0 support).
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    atoshi_devnet: {
      url: "http://localhost:8545",
      chainId: 88388,
      accounts: [PRIVATE_KEY],
      gasPrice: 20000000000, // 20 gwei
    },
    atoshi_testnet: {
      url: ATOSHI_TESTNET_RPC,
      chainId: 88288,
      accounts: [PRIVATE_KEY],
      gasPrice: 20000000000,
    },
    atoshi_mainnet: {
      url: ATOSHI_MAINNET_RPC,
      chainId: 88188,
      accounts: [PRIVATE_KEY],
      gasPrice: 20000000000,
    },
    atoshi_l2: {
      url: process.env.L2_RPC_URL || "http://52.76.210.218:8123",
      chainId: 67890,
      accounts: [PRIVATE_KEY],
      gasPrice: 1000000000, // 1 gwei
      timeout: 120000,
      httpHeaders: {
        "Content-Type": "application/json",
      },
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    gasPrice: 20,
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 60000,
  },
};

