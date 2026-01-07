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

