/**
 * Probe script: read-only checks against Monad testnet.
 *
 * Verifies:
 *  - chain id / block height
 *  - code presence at every documented Kuru testnet address (docs audit)
 *  - the official testnet MON-USDC market's base/quote tokens
 *  - whether Kuru's testnet USDC token has a public mint
 *  - wallet MON balance (funding status)
 *
 * Usage: npm run probe
 */
import { ethers, BigNumber } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";

const erc20ReadAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function codeLen(provider: ethers.providers.JsonRpcProvider, address: string): Promise<number> {
  const c = await provider.getCode(address);
  return (c.length - 2) / 2;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const network = await provider.getNetwork();
  console.log("== Network ==");
  console.log("chainId:", network.chainId, "(expected 10143)");
  console.log("block:", await provider.getBlockNumber());
  console.log("rpc:", cfg.RPC_URL);

  const accounts = await provider.send("eth_accounts", []);
  console.log("eth_accounts:", JSON.stringify(accounts));

  console.log("\n== Kuru testnet contracts (docs audit, eth_getCode) ==");
  const addrs: Array<[string, string]> = [
    ["Router (Contract-addresses page)", cfg.KURU_ROUTER_TESTNET],
    ["MarginAccount (Contract-addresses page)", cfg.KURU_MARGIN_TESTNET],
    ["Forwarder (Contract-addresses page)", cfg.KURU_FORWARDER_TESTNET],
    ["MonadDeployer (Contract-addresses page)", cfg.KURU_DEPLOYER_TESTNET],
    ["KuruUtils (Contract-addresses page)", cfg.KURU_UTILS_TESTNET],
    ["MON-USDC market (Contract-addresses page)", cfg.KURU_MON_USDC_MARKET_TESTNET],
    ["USDC testnet (Contract-addresses page)", cfg.TESTNET_USDC],
    // quickstart config.json addresses (older docs page) - expect dead:
    ["Router (quickstart config.json)", "0x1f5A250c4A506DA4cE584173c6ed1890B1bf7187"],
    ["MarginAccount (quickstart config.json)", "0xdDDaBd30785bA8b45e434a1f134BDf304d6125d9"],
  ];
  for (const [label, addr] of addrs) {
    try {
      const len = await codeLen(provider, addr);
      console.log(`${len > 0 ? "OK " : "DEAD"} ${label}: ${addr} (${len} bytes)`);
    } catch (e: any) {
      console.log(`ERR ${label}: ${addr} -> ${e.message}`);
    }
  }

  console.log("\n== Official MON-USDC market params ==");
  const mp = await KuruSdk.ParamFetcher.getMarketParams(provider, cfg.KURU_MON_USDC_MARKET_TESTNET);
  console.log("baseAssetAddress :", mp.baseAssetAddress, "(0x000..0 means native MON)");
  console.log("baseAssetDecimals:", mp.baseAssetDecimals.toString());
  console.log("quoteAssetAddress:", mp.quoteAssetAddress);
  console.log("quoteAssetDecimals:", mp.quoteAssetDecimals.toString());
  console.log("pricePrecision   :", mp.pricePrecision.toString());
  console.log("sizePrecision    :", mp.sizePrecision.toString());

  console.log("\n== Kuru official testnet USDC token ==");
  const usdc = new ethers.Contract(cfg.TESTNET_USDC, erc20ReadAbi, provider);
  try {
    console.log("name:", await usdc.name());
    console.log("symbol:", await usdc.symbol());
    console.log("decimals:", (await usdc.decimals()).toString());
    console.log("totalSupply:", (await usdc.totalSupply()).toString());
  } catch (e: any) {
    console.log("read failed:", e.message);
  }

  console.log("\n== USDC public-mint probe (eth_call from random address) ==");
  const from = "0x0000000000000000000000000000000000000001";
  const probes: Array<[string, string]> = [
    ["mint(address,uint256)", ethers.utils.id("mint(address,uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [from, 1000000]).slice(2)],
    ["mint(uint256)", ethers.utils.id("mint(uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["uint256"], [1000000]).slice(2)],
    ["faucet()", ethers.utils.id("faucet()").slice(0, 10)],
    ["grab(uint256)", ethers.utils.id("grab(uint256)").slice(0, 10) + ethers.utils.defaultAbiCoder.encode(["uint256"], [1000000]).slice(2)],
    ["drip()", ethers.utils.id("drip()").slice(0, 10)],
  ];
  for (const [label, data] of probes) {
    try {
      const res = await provider.call({ to: cfg.TESTNET_USDC, from, data });
      console.log(`${label.padEnd(24)} -> OK (${res.length > 2 ? "returns data" : "empty"})`);
    } catch (e: any) {
      const reason = e?.reason || e?.error?.message || e.message;
      console.log(`${label.padEnd(24)} -> reverts (${reason})`);
    }
  }

  console.log("\n== Wallet ==");
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.log("PRIVATE_KEY not set in .env");
  } else {
    const wallet = new ethers.Wallet(privateKey, provider);
    const address = await wallet.getAddress();
    const bal = await wallet.getBalance();
    console.log("address:", address);
    console.log("MON    :", ethers.utils.formatEther(bal), "MON");
    if (bal.lt(ethers.utils.parseEther("0.2"))) {
      console.log("WARNING: not enough MON for gas. Request testnet MON from https://faucet.monad.xyz");
    }
    const usdcBal = await usdc.balanceOf(address);
    console.log("USDC   :", ethers.utils.formatUnits(usdcBal, 6), "USDC");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });