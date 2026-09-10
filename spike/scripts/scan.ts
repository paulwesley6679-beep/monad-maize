import { ethers } from "ethers";
import * as KuruSdk from "@kuru-labs/kuru-sdk";
import * as cfg from "../src/config";

const routerAbi = require("@kuru-labs/kuru-sdk/abi/Router.json").abi;
const orderbookAbi = require("@kuru-labs/kuru-sdk/abi/OrderBook.json").abi;

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
  const router = new ethers.Contract(cfg.KURU_ROUTER_TESTNET, routerAbi, provider);
  const marketRegisteredTopic = ethers.utils.id(
    "MarketRegistered(address,address,address,address,uint32,uint96,uint32,uint96,uint96,uint256,uint256,uint96)"
  );
  const latest = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: cfg.KURU_ROUTER_TESTNET,
    topics: [marketRegisteredTopic],
    fromBlock: 1,
    toBlock: latest,
  });
  console.log("MarketRegistered events found:", logs.length);

  const markets: string[] = [];
  for (const log of logs) {
    const p = router.interface.parseLog(log);
    markets.push(p.args.market);
  }

  // Check trades on the official MON-USDC market in the last N blocks, then L2 books across markets.
  const tradeTopic = ethers.utils.id("Trade(uint40,address,bool,uint256,uint96,address,address,uint96)");
  try {
    const tradeLogs = await provider.getLogs({
      address: cfg.KURU_MON_USDC_MARKET_TESTNET,
      topics: [tradeTopic],
      fromBlock: latest - 50000,
      toBlock: latest,
    });
    console.log("MON-USDC market trades in last 50k blocks:", tradeLogs.length);
  } catch (e: any) {
    console.log("trade log query failed:", e.message);
  }

  // Show markets with live liquidity
  let withDepth = 0;
  for (const m of markets) {
    try {
      const mp = await KuruSdk.ParamFetcher.getMarketParams(provider, m);
      const l2 = await KuruSdk.OrderBook.getL2OrderBook(provider, m, mp);
      const bids = l2.bids.length;
      const asks = l2.asks.length;
      if (bids > 0 || asks > 0) {
        withDepth++;
        console.log(
          `MARKET ${m} base=${mp.baseAssetAddress} quote=${mp.quoteAssetAddress} bids=${bids} asks=${asks} topBid=${JSON.stringify(l2.bids[0] || null)} topAsk=${JSON.stringify(l2.asks[0] || null)}`
        );
      }
    } catch {
      /* skip */
    }
  }
  console.log("markets with depth:", withDepth, "of", markets.length);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });