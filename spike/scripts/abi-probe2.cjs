const ob = require("../node_modules/@kuru-labs/kuru-sdk/abi/OrderBook.json");
const fns = ob.abi.filter((a) => a.type === "function");
for (const f of fns) {
  if (/asset|token|margin|precision|tick|Size|Fee|Vault|Book|Order|Trade|price/i.test(f.name)) {
    console.log(
      f.name +
        "(" +
        f.inputs.map((i) => i.type + " " + i.name).join(", ") +
        ") => (" +
        f.outputs.map((o) => o.type + " " + o.name).join(", ") +
        ")"
    );
  }
}