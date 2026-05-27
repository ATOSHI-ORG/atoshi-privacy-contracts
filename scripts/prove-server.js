// ============================================================================
// 临时 prove 服务 (仅开发/测试用,生产必须换成移动端本地 .so prover)
// ============================================================================
//
// 用途: 安卓团队暂时无法本地编 ZK prover, 让他们 HTTP POST witness 到这里,
//      服务器跑 snarkjs 生成 proof 返回.
//
// ⚠️ 严重安全警告:
//   witness 里包含用户私钥 + Note 详情. 服务器看得到这些.
//   只能在公司内网部署, 接入端必须 HTTPS + 鉴权.
//   生产环境绝对不能用 — 隐私就破了.
//
// 用法:
//   cd atoshi-privacy-contracts
//   node scripts/prove-server.js
//   # 监听 0.0.0.0:3000
//
// 安卓调用:
//   POST http://<dev-mac-ip>:3000/prove/unshield
//   Body: { witnessJson: { root, nullifierHash, recipient, ... } }
//   返回: { proof: { pi_a, pi_b, pi_c, ... }, publicSignals: [...] }
// ============================================================================

const http = require("http");
const snarkjs = require("snarkjs");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PROVE_SERVER_PORT || 3000;
const CIRCUITS_ROOT = path.resolve(__dirname, "..", "..", "atoshi-privacy-circuits");

const CIRCUITS = {
  unshield: {
    wasm: path.join(CIRCUITS_ROOT, "build", "unshield", "unshield_js", "unshield.wasm"),
    zkey: path.join(CIRCUITS_ROOT, "keys", "unshield_final.zkey"),
  },
  transfer: {
    wasm: path.join(CIRCUITS_ROOT, "build", "transfer", "transfer_js", "transfer.wasm"),
    zkey: path.join(CIRCUITS_ROOT, "keys", "transfer_final.zkey"),
  },
};

// 检查电路文件都在
for (const [name, paths] of Object.entries(CIRCUITS)) {
  for (const [k, p] of Object.entries(paths)) {
    if (!fs.existsSync(p)) {
      console.error(`ERROR: ${name}.${k} 不存在: ${p}`);
      process.exit(1);
    }
  }
}
console.log("✓ 电路文件齐全");

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS (开发期方便)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const t0 = Date.now();
  const path = req.url.split("?")[0];

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", circuits: Object.keys(CIRCUITS) }));
    return;
  }

  const match = path.match(/^\/prove\/(unshield|transfer)$/);
  if (req.method !== "POST" || !match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST /prove/unshield or /prove/transfer" }));
    return;
  }

  const circuit = match[1];
  const config = CIRCUITS[circuit];

  try {
    const body = await readBody(req);
    const { witnessJson } = JSON.parse(body);
    if (!witnessJson) throw new Error("missing witnessJson");

    console.log(`[${new Date().toISOString()}] /prove/${circuit} 收到请求`);
    console.log(`  witness keys: ${Object.keys(witnessJson).join(", ")}`);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witnessJson, config.wasm, config.zkey,
    );

    // 把 proof 格式化成 Solidity 调用所需(G2 内层 swap)
    const pA = [proof.pi_a[0], proof.pi_a[1]];
    const pB = [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ];
    const pC = [proof.pi_c[0], proof.pi_c[1]];

    const elapsed = Date.now() - t0;
    console.log(`  ✓ proof 生成完毕 (${elapsed}ms)`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ proof, publicSignals, pA, pB, pC, elapsedMs: elapsed }));
  } catch (e) {
    console.error(`  ✗ FAIL: ${e.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  prove server listening on http://0.0.0.0:${PORT}`);
  console.log("  endpoints:");
  console.log("    GET  /health");
  console.log("    POST /prove/unshield  { witnessJson }");
  console.log("    POST /prove/transfer  { witnessJson }");
  console.log("\n  ⚠️  开发用,witness 含私钥,绝不能放生产!\n");
});
