import { ethers, BigNumber } from "ethers";

/**
 * Event parsers for Kuru OrderBook / Router receipts.
 * Sources:
 *  - OrderCreated / Trade event signatures: https://docs.kuru.io/sdk/quickstart-sdk (parseEvents)
 *  - MarketRegistered: https://docs.kuru.io/contracts/Router#marketregistered
 */

export interface TradeInfo {
  orderId: BigNumber; // the MAKER order id that was filled
  makerAddress: string;
  takerAddress: string;
  isBuy: boolean; // the TAKER order's direction (true = taker bought / maker side was the ask)
  price: BigNumber; // price raw, 18-decimal "wei" scale (e.g. 61.44 -> 61.44e18)
  filledSize: BigNumber; // filled size in sizePrecision units
}

export interface ParsedReceipt {
  newOrderIds: BigNumber[];
  trades: TradeInfo[];
  market?: string;
  vault?: string;
}

const ORDER_CREATED_TOPIC = ethers.utils.id("OrderCreated(uint40,address,uint96,uint32,bool)");
const TRADE_TOPIC = ethers.utils.id("Trade(uint40,address,bool,uint256,uint96,address,address,uint96)");
const MARKET_REGISTERED_TOPIC = ethers.utils.id(
  "MarketRegistered(address,address,address,address,uint32,uint96,uint32,uint96,uint96,uint256,uint256,uint96)"
);

export function parseEvents(receipt: ethers.ContractReceipt): ParsedReceipt {
  const newOrderIds: BigNumber[] = [];
  const trades: TradeInfo[] = [];
  let market: string | undefined;
  let vault: string | undefined;

  receipt.logs.forEach((log) => {
    if (log.topics[0] === ORDER_CREATED_TOPIC) {
      try {
        const decoded = ethers.utils.defaultAbiCoder.decode(
          ["uint40", "address", "uint96", "uint32", "bool"],
          log.data
        );
        newOrderIds.push(BigNumber.from(decoded[0]));
      } catch {
        /* ignore */
      }
    } else if (log.topics[0] === TRADE_TOPIC) {
      try {
        const decoded = ethers.utils.defaultAbiCoder.decode(
          ["uint40", "address", "bool", "uint256", "uint96", "address", "address", "uint96"],
          log.data
        );
        // Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price,
        //        uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)
        // All args non-indexed (verified against @kuru-labs/kuru-sdk/abi/OrderBook.json).
        trades.push({
          orderId: BigNumber.from(decoded[0]),
          makerAddress: decoded[1],
          isBuy: decoded[2],
          price: BigNumber.from(decoded[3]),
          filledSize: BigNumber.from(decoded[7]),
          takerAddress: decoded[5],
        });
      } catch {
        /* ignore */
      }
    } else if (log.topics[0] === MARKET_REGISTERED_TOPIC) {
      try {
        // All args non-indexed (from Router ABI in @kuru-labs/kuru-sdk/abi/Router.json)
        const decoded = ethers.utils.defaultAbiCoder.decode(
          [
            "address", // baseAsset
            "address", // quoteAsset
            "address", // market
            "address", // vaultAddress
            "uint32", // pricePrecision
            "uint96", // sizePrecision
            "uint32", // tickSize
            "uint96", // minSize
            "uint96", // maxSize
            "uint256", // takerFeeBps
            "uint256", // makerFeeBps
            "uint96", // kuruAmmSpread
          ],
          log.data
        );
        market = decoded[2];
        vault = decoded[3];
      } catch {
        /* ignore */
      }
    }
  });

  return { newOrderIds, trades, market, vault };
}