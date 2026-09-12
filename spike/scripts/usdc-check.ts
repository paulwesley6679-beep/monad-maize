/**
 * USDC identity check: is Kuru's official testnet USDC the same token as the
 * Monad Foundation token-list USDC (Circle's)? 
 *
 * Checks on-chain:
 *  - name / symbol / decimals / totalSupply at both addresses
 *  - deployed bytecode hash at both addresses (same contract?)
 *  - quote token of Kuru's official MON-USDC testnet market
 *  - mint/faucet entry points on both tokens (eth_call)
 *
 * Usage: npx tsx scripts/usdc-check.ts
 */
import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";

const CIRCLE_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3"; // Monad token-list "USDC"

const erc20ReadAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

async function tokenSummary(
  provider: ethers.providers.JsonRpcProvider,
  address: string,
  label: string
) {
  const t = new ethers.Contract(address, erc20ReadAbi, provider);
  const code = await provider.getCode(address);
  console.log(`\n== ${label} ==`);
  console.log("address     :", address);
  try {
    console.log("name        :", await t.name());
    console.log("symbol      :", await t.symbol());
    console.log("decimals    :", (await t.decimals()).toString());
    console.log("totalSupply :", (await t.totalSupply()).toString());
  } catch (e: any) {
    console.log("read failed :", e.message);
  }
  console.log("code bytes  :", (code.length - 2) / 2);
  console.log("code hash   :", ethers.utils.keccak256(code));

  // mint / faucet probing (eth_call from a burner address)
  const from = "0x0000000000000000000000000000000000000001";
  const probes: Array<[string, string]> = [
    ["mint(address,uint256)", ethers.utils.id("mint(address,uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [from, 1000000]).slice(2)],
    ["mint(uint256)", ethers.utils.id("mint(uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["uint256"], [1000000]).slice(2)],
    ["faucet()", ethers.utils.id("faucet()").slice(0, 10)],
    ["grab(uint256)", ethers.utils.id("grab(uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["uint256"], [1000000]).slice(2)],
    ["drip()", ethers.utils.id("drip()").slice(0, 10)],
    ["masterMinter()", ethers.utils.id("masterMinter()").slice(0, 10)],
  ];
  for (const [label2, data] of probes) {
    try {
      const res = await provider.call({ to: address, from, data });
      console.log(`  ${label2.padEnd(24)} -> OK (${res.length > 2 ? "returns data" : "empty"})`);
    } catch (e: any) {
      const reason = e?.reason || e?.error?.message || e.message;
      console.log(`  ${label2.padEnd(24)} -> reverts (${reason})`);
    }
  }
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  console.log("block:", await provider.getBlockNumber(), "chain:", (await provider.getNetwork()).chainId);

  const kuruUsdc = cfg.TESTNET_USDC.toLowerCase();
  const circleUsdc = CIRCLE_TESTNET_USDC.toLowerCase();

  await tokenSummary(provider, kuruUsdc, "Kuru official testnet USDC (docs.kuru.io/contracts/Contract-addresses)");
  await tokenSummary(provider, circleUsdc, "Monad token-list USDC (raw.githubusercontent.com/monad-crypto/token-list/main/tokenlist-testnet.json)");

  console.log("\n== same token? ==");
  const codeKuru = ethers.utils.keccak256(await provider.getCode(kuruUsdc));
  const codeCircle = ethers.utils.keccak256(await provider.getCode(circleUsdc));
  console.log("bytecode identical:", codeKuru === codeCircle);

  // What does Kuru's official MON-USDC market actually quote?
  console.log("\n== Kuru official MON-USDC market quote (on-chain) ==");
  const mp = await KuruSdk.ParamFetcher.getMarketParams(provider, cfg.KURU_MON_USDC_MARKET_TESTNET);
  console.log("market      :", cfg.KURU_MON_USDC_MARKET_TESTNET);
  console.log("baseAsset   :", mp.baseAssetAddress);
  console.log("quoteAsset  :", mp.quoteAssetAddress);
  console.log("quoteAsset == Kuru USDC (0x3bA3..570):", mp.quoteAssetAddress.toLowerCase() === kuruUsdc);
  console.log("quoteAsset == Circle USDC (0x534b..3A3):", mp.quoteAssetAddress.toLowerCase() === circleUsdc);
  console.log("baseAsset   == Circle USDC (0x534b..3A3):", mp.baseAssetAddress.toLowerCase() === circleUsdc);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });