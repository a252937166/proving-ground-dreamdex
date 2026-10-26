// Local JSON-RPC shim for forking Somnia Hideki with Foundry.
//
// The Hideki RPC answers eth_getBalance / eth_getCode / eth_getTransactionCount /
// eth_getStorageAt only for a plain block number or tag. Foundry's fork backend sends
// EIP-1898 objects ({ blockNumber } or { blockHash }) and the node rejects them with
// -32602 "invalid parameters". This shim rewrites those objects to a hex block number
// and forwards everything else unchanged. A { blockHash } is resolved with
// eth_getBlockByHash and then checked against eth_getBlockByNumber, so a hash that is
// not canonical is refused rather than silently read at another block.
//
// With SHIM_CACHE=1 it also remembers answers to state reads made at an explicit block
// number (eth_getStorageAt, eth_getCode, eth_getBalance, eth_getTransactionCount,
// eth_getBlockByNumber). State at a fixed past block does not change, and anvil asks
// for the same slots again after every evm_revert, so repeated fork runs stop paying
// one network round trip per slot.
//
// Usage: [SHIM_CACHE=1] node tools/rpc-shim.mjs [port] [upstream]
import http from "node:http";

const port = Number(process.argv[2] ?? process.env.SHIM_PORT ?? 8546);
const upstream = process.argv[3] ?? process.env.HIDEKI_RPC_URL ?? "https://api.hideki2.infra.testnet.somnia.network";

// Index of the block parameter for each method that takes one.
const BLOCK_PARAM = {
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_call: 1,
  eth_estimateGas: 1,
};

const counts = new Map();
const hashToNumber = new Map();
const CACHEABLE = { eth_getStorageAt: 2, eth_getCode: 1, eth_getBalance: 1, eth_getTransactionCount: 1, eth_getBlockByNumber: 0 };
const cache = process.env.SHIM_CACHE === "1" ? new Map() : null;
let hits = 0;

// Transport failures (the upstream dropping a connection under many concurrent fork
// reads) are retried; a JSON-RPC error answer is returned as is.
async function post(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return await res.json();
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
}

async function canonicalNumberForHash(hash) {
  const cached = hashToNumber.get(hash);
  if (cached) return cached;
  const byHash = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: [hash, false] });
  const number = byHash.result?.number;
  if (!number) throw new Error(`unknown block hash ${hash}`);
  const byNumber = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [number, false] });
  if (byNumber.result?.hash?.toLowerCase() !== hash.toLowerCase()) throw new Error(`block hash ${hash} is not canonical at ${number}`);
  hashToNumber.set(hash, number);
  return number;
}

async function rewrite(req) {
  counts.set(req.method, (counts.get(req.method) ?? 0) + 1);
  const index = BLOCK_PARAM[req.method];
  if (index === undefined || !Array.isArray(req.params)) return req;
  const block = req.params[index];
  if (block === null || typeof block !== "object") return req;
  const params = [...req.params];
  if (block.blockNumber !== undefined) params[index] = block.blockNumber;
  else if (block.blockHash !== undefined) params[index] = await canonicalNumberForHash(block.blockHash);
  return { ...req, params };
}

async function handleOne(req) {
  try {
    const rewritten = await rewrite(req);
    const index = CACHEABLE[rewritten.method];
    const block = index === undefined || !Array.isArray(rewritten.params) ? undefined : rewritten.params[index];
    const key = cache && typeof block === "string" && /^0x[0-9a-f]+$/i.test(block) ? `${rewritten.method}:${JSON.stringify(rewritten.params)}` : null;
    if (key && cache.has(key)) {
      hits++;
      return { jsonrpc: "2.0", id: req.id ?? null, result: cache.get(key) };
    }
    const answer = await post(rewritten);
    if (key && answer && answer.error === undefined && answer.result !== undefined && answer.result !== null) cache.set(key, answer.result);
    return answer;
  } catch (err) {
    return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32000, message: `rpc-shim: ${err.message}` } };
  }
}

const server = http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", async () => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handleOne)) : await handleOne(parsed);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(out));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`rpc-shim http://127.0.0.1:${port} -> ${upstream}`));
process.on("SIGTERM", () => {
  console.log("rpc-shim calls:", JSON.stringify(Object.fromEntries(counts)), cache ? `cache hits ${hits}, entries ${cache.size}` : "");
  process.exit(0);
});
