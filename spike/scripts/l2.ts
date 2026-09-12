import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const marketAddress = cfg.KURU_MON_USDC_MARKET_TESTNET;
  const marketParams = await KuruSdk.ParamFetcher.getMarketParams(provider, marketAddress);
  console.log("Market:", marketAddress);
  console.log("quote:", marketParams.quoteAssetAddress, "base:", marketParams.baseAssetAddress);

  const l2 = await KuruSdk.OrderBook.getL2OrderBook(provider, marketAddress, marketParams);
  console.log("bids (top 5):", JSON.stringify(l2.bids.slice(0, 5)));
  console.log("asks (top 5):", JSON.stringify(l2.asks.slice(0, 5)));
  console.log("bid count:", l2.bids.length, "ask count:", l2.asks.length);

  const orderbook = new ethers.Contract(marketAddress, require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi, provider);
  const vaultParams = await orderbook.getVaultParams();
  console.log("vault address:", vaultParams[0]);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });