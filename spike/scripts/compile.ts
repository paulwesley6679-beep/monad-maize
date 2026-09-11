/**
 * Compiles contracts/*.sol with solc-js and writes one artifact JSON per
 * contract to artifacts/. Usage: npm run compile
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require("solc");

const projectRoot = path.join(__dirname, "..");
const contractsDir = path.join(projectRoot, "contracts");
const sources: Record<string, { content: string }> = {};
const contractNames: string[] = [];

for (const file of fs.readdirSync(contractsDir).filter((f) => f.endsWith(".sol"))) {
  sources[file] = { content: fs.readFileSync(path.join(contractsDir, file), "utf8") };
  contractNames.push(file.replace(/\.sol$/, ""));
}

const input = {
  language: "Solidity",
  sources,
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

const artifactsDir = path.join(projectRoot, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

for (const file of Object.keys(output.contracts)) {
  for (const [contractName, contract] of Object.entries<any>(output.contracts[file])) {
    const artifact = {
      contractName,
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
    };
    const outPath = path.join(artifactsDir, `${contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log("Wrote", outPath, `(ABI entries: ${contract.abi.length})`);
  }
}
console.log("Compiled contracts:", contractNames.join(", "));