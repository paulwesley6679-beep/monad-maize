const ob = require("../node_modules/@kuru-labs/kuru-sdk/abi/OrderBook.json");
const names = [
  "addBuyOrder", "addSellOrder", "placeAndExecuteMarketBuy", "placeAndExecuteMarketSell",
  "getL2Book", "getVaultParams", "getBestBid", "getBestAsk",
  "quoteAsset", "baseAsset", "quoteAssetAddr", "baseAssetAddr",
  "getUserTrades", "getTrades", "getUserOrders", "getOpenOrders",
  "cancelOrder", "fees", "getFees", "takerFee", "makerFee",
];
for (const n of names) {
  const f = ob.abi.filter((a) => a.type === "function" && a.name === n);
  if (f.length) {
    console.log(n + ": " + f.map((x) => "(" + x.inputs.map((i) => i.type + " " + i.name).join(", ") + ") => (" + x.outputs.map((o) => o.type + " " + o.name).join(", ") + ")").join(" | "));
  }
}