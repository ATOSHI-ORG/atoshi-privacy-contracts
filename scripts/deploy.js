const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // 1. Deploy Verifier
  console.log("\n1. Deploying Groth16Verifier...");
  const Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("   Groth16Verifier deployed to:", verifierAddress);

  // 2. Deploy TokenRegistry
  console.log("\n2. Deploying TokenRegistry...");
  const TokenRegistry = await hre.ethers.getContractFactory("TokenRegistry");
  const tokenRegistry = await TokenRegistry.deploy();
  await tokenRegistry.waitForDeployment();
  const tokenRegistryAddress = await tokenRegistry.getAddress();
  console.log("   TokenRegistry deployed to:", tokenRegistryAddress);

  // 3. Deploy Shield
  console.log("\n3. Deploying Shield...");
  const Shield = await hre.ethers.getContractFactory("Shield");
  const shield = await Shield.deploy(
    verifierAddress,
    deployer.address // Fee recipient
  );
  await shield.waitForDeployment();
  const shieldAddress = await shield.getAddress();
  console.log("   Shield deployed to:", shieldAddress);

  // 4. Configure Shield
  console.log("\n4. Configuring Shield...");
  
  // Set minimum deposit for native token
  // Native token is already supported by default
  console.log("   Native token (ATOS) already supported");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network:        ${hre.network.name}`);
  console.log(`Chain ID:       ${(await hre.ethers.provider.getNetwork()).chainId}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log("-".repeat(60));
  console.log(`Verifier:       ${verifierAddress}`);
  console.log(`TokenRegistry:  ${tokenRegistryAddress}`);
  console.log(`Shield:         ${shieldAddress}`);
  console.log("=".repeat(60));

  // Save deployment addresses
  const fs = require("fs");
  const deploymentInfo = {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      Verifier: verifierAddress,
      TokenRegistry: tokenRegistryAddress,
      Shield: shieldAddress,
    }
  };

  const deploymentPath = `./deployments/${hre.network.name}.json`;
  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment info saved to: ${deploymentPath}`);

  // Verify contracts (if not on localhost)
  if (hre.network.name !== "localhost" && hre.network.name !== "hardhat") {
    console.log("\nWaiting for block confirmations...");
    await verifier.deploymentTransaction().wait(5);
    
    console.log("\nVerifying contracts on explorer...");
    try {
      await hre.run("verify:verify", {
        address: verifierAddress,
        constructorArguments: [],
      });
      console.log("Verifier verified!");
    } catch (e) {
      console.log("Verifier verification failed:", e.message);
    }

    try {
      await hre.run("verify:verify", {
        address: shieldAddress,
        constructorArguments: [verifierAddress, deployer.address],
      });
      console.log("Shield verified!");
    } catch (e) {
      console.log("Shield verification failed:", e.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

