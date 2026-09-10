/**
 * Compiles contracts/SpikeToken.sol with solc-js and writes artifacts.
 * Usage: npm run compile
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require("solc");

const projectRoot = path.join(__dirname, "..");
const sourcePath = path.join(projectRoot, "contracts", "SpikeToken.sol");
const source = fs.readFileSync(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "SpikeToken.sol": { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object"] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  const errors = output.errors.filter((e: any) => e.severity === "error");
  if (errors.length > 0) {
    console.error(output.errors.map((e: any) => `${e.severity}: ${e.formattedMessage}`).join("\n"));
    process.exit(1);
  }
}

const contract = output.contracts["SpikeToken.sol"].SpikeToken;
if (!contract) {
  console.error("SpikeToken not found in compilation output");
  process.exit(1);
}

const artifact = {
  contractName: "SpikeToken",
  abi: contract.abi,
  bytecode: "0x" + contract.evm.bytecode.object,
};

const artifactsDir = path.join(projectRoot, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });
const outPath = path.join(artifactsDir, "SpikeToken.json");
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log("Wrote", outPath);
console.log("ABI entries:", contract.abi.length);