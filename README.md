# Atoshi Privacy Contracts

Privacy-preserving smart contracts for Atoshi Chain, enabling confidential transactions using Zero-Knowledge Proofs.

## 🏗️ Architecture

```
contracts/
├── core/
│   ├── Shield.sol          # Main privacy pool contract
│   └── Verifier.sol        # ZK-SNARK proof verifier (Groth16)
├── interfaces/
│   └── IShield.sol         # Interface definitions
├── libraries/
│   ├── MerkleTree.sol      # Incremental Merkle tree
│   └── Poseidon.sol        # Poseidon hash function
└── tokens/
    ├── TokenRegistry.sol   # Multi-token support
    └── MockERC20.sol       # Test token
```

## 🔐 How It Works

### Deposit Flow
1. User generates a **commitment** off-chain: `commitment = Poseidon(amount, token, pubKey, blinding)`
2. User calls `Shield.deposit(commitment, token, amount)`
3. Contract inserts commitment into Merkle tree
4. User stores the secret data (Note) locally

### Withdraw Flow
1. User generates a **ZK proof** off-chain proving:
   - They know the secret data for a commitment in the tree
   - The nullifier is correctly derived
2. User calls `Shield.withdraw(proof, root, nullifier, recipient, ...)`
3. Contract verifies the proof and checks nullifier hasn't been used
4. Contract transfers tokens to recipient

### Private Transfer
- Spend an existing Note and create a new Note in one transaction
- Ownership changes without leaving the privacy pool

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18
- npm or yarn

### Installation

```bash
cd atoshi-privacy-contracts
npm install
```

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
npm run test
```

### Deploy

```bash
# Local network
npm run node  # In terminal 1
npm run deploy:local  # In terminal 2

# Atoshi Testnet
npm run deploy:testnet

# Atoshi Mainnet
npm run deploy:mainnet
```

## 📋 Contract Details

### Shield.sol

Main privacy pool contract.

| Function | Description |
|----------|-------------|
| `deposit(commitment, token, amount)` | Deposit tokens into privacy pool |
| `withdraw(proof, root, nullifier, recipient, ...)` | Withdraw with ZK proof |
| `transfer(proof, root, nullifier, newCommitment)` | Private transfer within pool |
| `isKnownRoot(root)` | Check if Merkle root is valid |
| `isSpent(nullifier)` | Check if nullifier is used |

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `TREE_LEVELS` | 20 | Merkle tree depth (~1M deposits) |
| `ROOT_HISTORY_SIZE` | 100 | Number of historical roots stored |
| `protocolFeeBps` | 30 | Protocol fee (0.3%) |

### Verifier.sol

Groth16 ZK-SNARK verifier. This is a template - the actual verifier will be generated from the circuit.

```bash
# Generate verifier from circuit
snarkjs zkey export solidityverifier circuit_final.zkey Verifier.sol
```

## 🔧 Development

### Project Structure

```
atoshi-privacy-contracts/
├── contracts/           # Solidity contracts
├── test/               # Test files
├── scripts/            # Deployment scripts
├── deployments/        # Deployment artifacts
├── hardhat.config.js   # Hardhat configuration
└── package.json
```

### Testing

```bash
# Run all tests
npm run test

# Run with coverage
npm run test:coverage

# Run with gas reporting
REPORT_GAS=true npm run test
```

### Linting

```bash
npm run lint
npm run lint:fix
```

## 🌐 Networks

| Network | Chain ID | RPC |
|---------|----------|-----|
| Atoshi Devnet | 88388 | http://localhost:8545 |
| Atoshi Testnet | 88288 | TBD |
| Atoshi Mainnet | 88188 | TBD |

## 🔒 Security Considerations

1. **Verifier Contract**: Must be generated from trusted setup
2. **Poseidon Hash**: Current implementation is placeholder - use circomlibjs generated version
3. **Nullifier**: Prevents double-spending
4. **Root History**: Allows withdrawals even if tree is updated

## 📚 References

- [Tornado Cash](https://github.com/tornadocash/tornado-core) - Original privacy pool design
- [Circom](https://docs.circom.io/) - ZK circuit language
- [snarkjs](https://github.com/iden3/snarkjs) - ZK proof generation/verification

## 📄 License

MIT License

