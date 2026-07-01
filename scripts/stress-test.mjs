/**
 * Stress / soak test for the Aula backend — hammers the API with many concurrent
 * clients to prove the resilience guards hold under a pile-up: the process must
 * NOT crash, server errors (5xx that aren't load-shed/timeout) stay ~0, and
 * excess load is shed with 503 rather than exhausting the pool/event loop.
 *
 * Usage (backend already running):
 *   node scripts/stress-test.mjs
 *   BASE=http://localhost:4000/api/v1 CONCURRENCY=100 DURATION_MS=10000 \
 *     CHECKOUT_RATIO=0.1 node scripts/stress-test.mjs
 *
 * No dependencies — uses global fetch (Node 18+). Auth uses the dev persona
 * login, so run the backend with AULA_DEV_AUTH=true.
 */
const BASE = process.env.BASE ?? "http://localhost:4055/api/v1";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 80);
const DURATION_MS = Number(process.env.DURATION_MS ?? 8000);
const CHECKOUT_RATIO = Number(process.env.CHECKOUT_RATIO ?? 0.08);
const ACTOR = process.env.ACTOR ?? "admin";

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: ACTOR }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const body = await res.json();
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  const csrf = /aula_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
  return { token: body.token, cookie, csrf };
}

async function pickSeed(auth) {
  const h = { authorization: `Bearer ${auth.token}` };
  const p = await fetch(`${BASE}/entities/product?pageSize=1&filter.active=true`, { headers: h })
    .then((r) => r.json())
    .catch(() => ({}));
  const product = p.items?.[0] ?? null;
  const w = await fetch(`${BASE}/entities/warehouse?pageSize=1`, { headers: h })
    .then((r) => r.json())
    .catch(() => ({}));
  const warehouse = w.items?.[0] ?? null;
  const code = product?.barcode ?? product?.sku ?? "0000000000000";
  return { product, warehouse, code };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function run() {
  console.log(`Stress test → ${BASE}`);
  console.log(`  concurrency=${CONCURRENCY} duration=${DURATION_MS}ms checkoutRatio=${CHECKOUT_RATIO}`);

  const healthBefore = await fetch(`${BASE}/health`).then((r) => r.json());
  const auth = await login();
  const seed = await pickSeed(auth);
  const authHeaders = { authorization: `Bearer ${auth.token}` };
  const writeHeaders = {
    authorization: `Bearer ${auth.token}`,
    "content-type": "application/json",
    cookie: auth.cookie,
    "x-csrf-token": auth.csrf,
  };

  const reads = [
    () => fetch(`${BASE}/health`),
    () => fetch(`${BASE}/auth/me`, { headers: authHeaders }),
    () => fetch(`${BASE}/pos/lookup?code=${encodeURIComponent(seed.code)}`, { headers: authHeaders }),
    () => fetch(`${BASE}/entities/product?pageSize=25`, { headers: authHeaders }),
    () => fetch(`${BASE}/stats`, { headers: authHeaders }),
  ];
  const checkout = () =>
    fetch(`${BASE}/pos/checkout`, {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify({
        warehouseId: seed.warehouse?.id ?? null,
        currencyCode: "USD",
        lines: [
          {
            productId: seed.product?.id ?? null,
            description: seed.product?.name ?? "Stress item",
            qty: 1,
            unitPrice: Number(seed.product?.unitPrice ?? 1),
            taxRate: Number(seed.product?.taxRate ?? 0),
          },
        ],
        payments: [{ method: "cash", amount: Number(seed.product?.unitPrice ?? 1) }],
      }),
    });

  const lat = [];
  const status = {}; // code -> count
  let shed = 0;
  let timeout = 0;
  let serverErr = 0;
  let netErr = 0;
  let total = 0;

  const deadline = Date.now() + DURATION_MS;
  async function worker() {
    while (Date.now() < deadline) {
      const doWrite = seed.product && Math.random() < CHECKOUT_RATIO;
      const op = doWrite ? checkout : reads[Math.floor(Math.random() * reads.length)];
      const t0 = nowMs();
      try {
        const res = await op();
        const ms = nowMs() - t0;
        lat.push(ms);
        total++;
        status[res.status] = (status[res.status] ?? 0) + 1;
        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          if (body?.error?.code === "OVERLOADED") shed++;
          else if (body?.error?.code === "TIMEOUT") timeout++;
          else serverErr++;
        } else if (res.status >= 500) {
          serverErr++;
        } else {
          await res.arrayBuffer().catch(() => {}); // drain body to free the socket
        }
      } catch {
        netErr++;
        total++;
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - started) / 1000;

  const healthAfter = await fetch(`${BASE}/health`)
    .then((r) => r.json())
    .catch(() => null);

  lat.sort((a, b) => a - b);
  const rps = Math.round(total / elapsed);
  console.log("\n──────── RESULTS ────────");
  console.log(`requests:        ${total}  (${rps} req/s over ${elapsed.toFixed(1)}s)`);
  console.log(`latency ms:      p50=${percentile(lat, 50).toFixed(1)}  p90=${percentile(lat, 90).toFixed(1)}  p99=${percentile(lat, 99).toFixed(1)}  max=${(lat[lat.length - 1] ?? 0).toFixed(1)}`);
  console.log(`status codes:    ${JSON.stringify(status)}`);
  console.log(`load-shed (503): ${shed}   timeouts: ${timeout}`);
  console.log(`server errors:   ${serverErr}   network errors: ${netErr}`);
  console.log(`health before:   status=${healthBefore?.status} inflight=${healthBefore?.inflight}`);
  console.log(`health after:    status=${healthAfter?.status} inflight=${healthAfter?.inflight}`);

  const survived = healthAfter?.status === "ok";
  const ok = survived && serverErr === 0 && netErr === 0;
  console.log(`\nVERDICT: ${ok ? "PASS ✅ (no crash, no unexpected 5xx/network errors)" : survived ? "DEGRADED ⚠️ (server up but saw errors)" : "FAIL ❌ (server unhealthy after load)"}`);
  process.exit(ok ? 0 : 1);
}

run().catch((e) => {
  console.error("stress test error:", e);
  process.exit(1);
});
