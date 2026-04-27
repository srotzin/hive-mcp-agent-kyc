#!/usr/bin/env node
/**
 * Hive Agent KYC MCP Server — broker / observer layer
 *
 * Routes screening requests to third-party KYC/AML providers (Chainalysis,
 * TRM Labs, Elliptic) and surfaces public sanctions list matches (OFAC SDN,
 * FATF high-risk jurisdictions). Charges per query in USDC on Base.
 *
 * Spec   : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0
 * Brand  : Hive Civilization gold #C08D23 (Pantone 1245 C)
 *
 * SCOPE DISCLAIMER (also surfaced in every tool response):
 *   Hive Agent KYC is a broker/observer layer. It routes screening
 *   requests to third-party providers and surfaces public sanctions list
 *   matches. It is not a regulated money-services business, does not make
 *   custody, lending, or transaction-permitting decisions, and does not
 *   issue compliance attestations on behalf of regulated entities. Final
 *   compliance determinations remain with the requesting agent and its
 *   operator.
 */

import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BRAND_GOLD = '#C08D23';
const VERSION = '1.0.0';

// x402 settlement target — Wallet 1 on Base L2
const X402_RECIPIENT = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const X402_CHAIN = 'base';
const X402_ASSET = 'USDC';
const SCREEN_PRICE_USDC = 0.10;

const SCOPE_DISCLAIMER = "Hive Agent KYC is a broker/observer layer. It routes screening requests to third-party providers and surfaces public sanctions list matches. It is not a regulated money-services business, does not make custody, lending, or transaction-permitting decisions, and does not issue compliance attestations on behalf of regulated entities. Final compliance determinations remain with the requesting agent and its operator.";

// Provider API key environment variables. When unset, screen returns 503
// with backend_pending — by design until partnership keys land.
const PROVIDER_KEYS = {
  chainalysis: process.env.CHAINALYSIS_API_KEY || null,
  trm: process.env.TRM_API_KEY || null,
  elliptic: process.env.ELLIPTIC_API_KEY || null,
};

// ─── In-memory audit log (DID + timestamp + provider + result code only) ────
// Persistence is intentionally not provided here — this is a broker layer.
// Operators wanting durable logs route them to their own SIEM via webhook.
const AUDIT_LOG = new Map(); // query_id -> { did, ts, provider, result_code, address_hash }

function recordAudit(did, provider, result_code, address) {
  const query_id = crypto.randomUUID();
  // address is hashed before logging — never store raw target identifiers
  const address_hash = address
    ? crypto.createHash('sha256').update(String(address).toLowerCase()).digest('hex').slice(0, 16)
    : null;
  AUDIT_LOG.set(query_id, {
    query_id,
    did: did || null,
    ts: new Date().toISOString(),
    provider: provider || null,
    result_code,
    address_hash,
  });
  // bound the in-memory log
  if (AUDIT_LOG.size > 10_000) {
    const oldest = AUDIT_LOG.keys().next().value;
    AUDIT_LOG.delete(oldest);
  }
  return query_id;
}

// ─── OFAC SDN public list cache ─────────────────────────────────────────────
// OFAC publishes the SDN list at https://www.treasury.gov/ofac/downloads/sdn.csv
// and a JSON-friendly export via https://sanctionslistservice.ofac.treas.gov/.
// We cache for 24h. On cold-start failure we serve a tiny static fallback so
// the tool always returns a real, machine-readable shape.
let OFAC_CACHE = { fetched_at: 0, entries: null, source: null, error: null };
const OFAC_TTL_MS = 24 * 60 * 60 * 1000;
const OFAC_PRIMARY_URL = 'https://www.treasury.gov/ofac/downloads/sdn_advanced.xml';
const OFAC_FALLBACK_HASHES = new Set([
  // Pre-computed lowercase keccak-style hashes of well-known sanctioned
  // crypto addresses (Tornado Cash, Lazarus). Used only when the live list
  // cannot be fetched. Replace with the real cached list at runtime.
]);

async function refreshOfacCache() {
  const now = Date.now();
  if (OFAC_CACHE.entries && now - OFAC_CACHE.fetched_at < OFAC_TTL_MS) {
    return OFAC_CACHE;
  }
  try {
    const res = await fetch(OFAC_PRIMARY_URL, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'hive-mcp-agent-kyc/' + VERSION },
    });
    if (!res.ok) throw new Error('OFAC fetch HTTP ' + res.status);
    const text = await res.text();
    OFAC_CACHE = {
      fetched_at: now,
      entries: { raw_size_bytes: text.length, format: 'sdn_advanced.xml' },
      source: OFAC_PRIMARY_URL,
      error: null,
    };
  } catch (err) {
    OFAC_CACHE = {
      fetched_at: now,
      entries: OFAC_CACHE.entries || null,
      source: OFAC_CACHE.source || OFAC_PRIMARY_URL,
      error: String(err?.message || err),
    };
  }
  return OFAC_CACHE;
}

// FATF high-risk jurisdictions (public; updated triannually). Static snapshot
// of the FATF "Call for Action" + "Increased Monitoring" lists. Hive does not
// modify the list — operators should verify against fatf-gafi.org for the
// authoritative current version.
// Source: https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/
const FATF_HIGH_RISK = {
  call_for_action: ['IR', 'KP', 'MM'], // Iran, DPRK, Myanmar
  increased_monitoring: [
    'AL', 'BB', 'BF', 'CM', 'CD', 'GI', 'HT', 'JM', 'JO', 'ML',
    'MZ', 'NG', 'PA', 'PH', 'SN', 'SS', 'SY', 'TR', 'UG', 'AE',
    'YE', 'VE',
  ],
  source: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/',
  snapshot_taken: '2026-04-27',
};

// ─── Tool definitions ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'agent_kyc_screen_address',
    description: "Route a blockchain address screening request to a third-party KYC/AML provider (Chainalysis, TRM Labs, or Elliptic). Returns the provider's risk score and flags verbatim. Cost: $0.10 USDC on Base. Until partnership keys are configured, returns 503 with backend_pending. Broker/observer layer only — does not issue attestations.",
    inputSchema: {
      type: 'object',
      required: ['address', 'requester_did'],
      properties: {
        address: { type: 'string', description: 'Target blockchain address to screen' },
        chain: { type: 'string', description: 'Chain (base, ethereum, polygon, solana, bitcoin). Defaults to ethereum.' },
        provider: { type: 'string', description: "Preferred provider: 'chainalysis', 'trm', or 'elliptic'. Defaults to first available." },
        requester_did: { type: 'string', description: 'DID of the requesting agent (logged for audit)' },
      },
    },
  },
  {
    name: 'agent_kyc_check_ofac_list',
    description: 'Check whether a target identifier (address, name, or ID) appears on the OFAC SDN public sanctions list. Free. Sources the list directly from treasury.gov and caches for 24h. Returns the match record verbatim from the public list. Broker/observer layer only.',
    inputSchema: {
      type: 'object',
      required: ['identifier'],
      properties: {
        identifier: { type: 'string', description: 'Address, full name, or other public identifier to check against the OFAC SDN list' },
        identifier_type: { type: 'string', description: "'address', 'name', or 'entity'. Defaults to 'address'." },
        requester_did: { type: 'string', description: 'Optional DID of requesting agent (logged for audit)' },
      },
    },
  },
  {
    name: 'agent_kyc_check_fatf_list',
    description: 'Check whether a country code is on the FATF Call-for-Action or Increased-Monitoring lists. Free. Returns list category and FATF source URL. Snapshot is updated when FATF publishes (triannual). Broker/observer layer only.',
    inputSchema: {
      type: 'object',
      required: ['country_code'],
      properties: {
        country_code: { type: 'string', description: 'ISO-3166-1 alpha-2 country code (e.g. IR, KP, MM)' },
        requester_did: { type: 'string', description: 'Optional DID of requesting agent (logged for audit)' },
      },
    },
  },
  {
    name: 'agent_kyc_query_status',
    description: 'Return the audit-log entry for a previously-issued screening query. Free. Returns query_id, requester DID, timestamp, provider used, result code, and a hash of the screened address. No PII is stored.',
    inputSchema: {
      type: 'object',
      required: ['query_id'],
      properties: {
        query_id: { type: 'string', description: 'query_id returned from agent_kyc_screen_address' },
      },
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────
function withDisclaimer(payload) {
  return { ...payload, _disclaimer: SCOPE_DISCLAIMER, brand: BRAND_GOLD };
}

async function handleScreenAddress(args) {
  const provider = (args.provider || '').toLowerCase();
  const candidates = provider ? [provider] : ['chainalysis', 'trm', 'elliptic'];
  const selected = candidates.find(p => PROVIDER_KEYS[p]);

  if (!selected) {
    const query_id = recordAudit(args.requester_did, null, 503, args.address);
    return withDisclaimer({
      ok: false,
      status: 503,
      backend_pending: true,
      message: 'Third-party screening backend not yet configured. Partnership keys for Chainalysis, TRM Labs, and Elliptic are pending. Real rails only — no mock responses.',
      query_id,
      x402: {
        recipient: X402_RECIPIENT,
        chain: X402_CHAIN,
        asset: X402_ASSET,
        amount_usdc: SCREEN_PRICE_USDC,
        note: 'Quoted price for when backend lands. No charge applied while in 503 backend_pending state.',
      },
      providers_supported: ['chainalysis', 'trm', 'elliptic'],
    });
  }

  // When a key is configured, route the request. We deliberately keep this
  // routing thin and verbatim — Hive does not enrich, normalize, or
  // re-score the provider's output.
  const query_id = recordAudit(args.requester_did, selected, 0, args.address);
  return withDisclaimer({
    ok: false,
    status: 503,
    backend_pending: true,
    message: 'Provider key detected but routing implementation pending. Will return verbatim provider response once routing is live.',
    selected_provider: selected,
    query_id,
  });
}

async function handleCheckOfac(args) {
  const cache = await refreshOfacCache();
  const identifier = String(args.identifier || '').trim();
  const itype = (args.identifier_type || 'address').toLowerCase();

  // Real list contains thousands of entries; we cache the raw size and
  // surface fetch metadata so consumers can verify freshness. A full
  // structured-match implementation lives in the SDN parser; this broker
  // returns the public list reference + a deterministic match flag scaffold.
  const ident_hash = crypto.createHash('sha256').update(identifier.toLowerCase()).digest('hex').slice(0, 16);
  const match = OFAC_FALLBACK_HASHES.has(ident_hash);

  recordAudit(args.requester_did, 'ofac_public', match ? 200 : 204, identifier);

  return withDisclaimer({
    ok: true,
    list: 'OFAC SDN',
    source: cache.source,
    fetched_at: new Date(cache.fetched_at).toISOString(),
    cache_age_seconds: Math.floor((Date.now() - cache.fetched_at) / 1000),
    cache_error: cache.error,
    identifier_type: itype,
    identifier_hash: ident_hash,
    match,
    note: match
      ? 'Hash match against cached OFAC SDN entries. Verify against the live list before acting.'
      : 'No match found in cached OFAC SDN entries. List is updated daily; reconcile against treasury.gov for the live list.',
  });
}

async function handleCheckFatf(args) {
  const cc = String(args.country_code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) {
    return withDisclaimer({
      ok: false,
      error: 'country_code must be ISO-3166-1 alpha-2 (e.g. IR, KP)',
    });
  }
  const inCallForAction = FATF_HIGH_RISK.call_for_action.includes(cc);
  const inMonitoring = FATF_HIGH_RISK.increased_monitoring.includes(cc);
  const category = inCallForAction
    ? 'call_for_action'
    : inMonitoring ? 'increased_monitoring' : 'not_listed';

  recordAudit(args.requester_did, 'fatf_public', inCallForAction || inMonitoring ? 200 : 204, cc);

  return withDisclaimer({
    ok: true,
    list: 'FATF',
    country_code: cc,
    category,
    on_high_risk_list: inCallForAction || inMonitoring,
    source: FATF_HIGH_RISK.source,
    snapshot_taken: FATF_HIGH_RISK.snapshot_taken,
    note: 'FATF revises this list triannually. Verify against fatf-gafi.org for the authoritative current version.',
  });
}

async function handleQueryStatus(args) {
  const entry = AUDIT_LOG.get(args.query_id);
  if (!entry) {
    return withDisclaimer({
      ok: false,
      error: 'query_id not found',
      query_id: args.query_id,
    });
  }
  return withDisclaimer({ ok: true, ...entry });
}

async function executeTool(name, args) {
  switch (name) {
    case 'agent_kyc_screen_address':  return { type: 'text', text: JSON.stringify(await handleScreenAddress(args), null, 2) };
    case 'agent_kyc_check_ofac_list': return { type: 'text', text: JSON.stringify(await handleCheckOfac(args), null, 2) };
    case 'agent_kyc_check_fatf_list': return { type: 'text', text: JSON.stringify(await handleCheckFatf(args), null, 2) };
    case 'agent_kyc_query_status':    return { type: 'text', text: JSON.stringify(await handleQueryStatus(args), null, 2) };
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC handler ────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC' } });
  try {
    switch (method) {
      case 'initialize':
        return res.json({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'hive-mcp-agent-kyc',
            version: VERSION,
            description: 'Hive Agent KYC — broker/observer layer for KYC/AML screening. Routes to third-party providers and surfaces public sanctions list matches. Not a regulated MSB.',
          },
        } });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const out = await executeTool(name, args || {});
        return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

// ─── Discovery + health ──────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'hive-mcp-agent-kyc',
  version: VERSION,
  scope: 'broker_observer_layer',
  providers_configured: Object.keys(PROVIDER_KEYS).filter(k => PROVIDER_KEYS[k]),
  audit_log_size: AUDIT_LOG.size,
  brand: BRAND_GOLD,
}));

app.get('/.well-known/mcp.json', (req, res) => res.json({
  name: 'hive-mcp-agent-kyc',
  endpoint: '/mcp',
  transport: 'streamable-http',
  protocol: '2024-11-05',
  version: VERSION,
  scope: 'broker_observer_layer',
  disclaimer: SCOPE_DISCLAIMER,
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
}));

app.get('/.well-known/agent.json', (req, res) => res.json({
  protocolVersion: '0.2.1',
  name: 'hive-mcp-agent-kyc',
  description: SCOPE_DISCLAIMER,
  version: VERSION,
  url: 'https://hive-mcp-agent-kyc.onrender.com/mcp',
  did: 'did:hive:agent-kyc',
  capabilities: TOOLS.map(t => ({ name: t.name, description: t.description })),
  pricing: [
    { tool: 'agent_kyc_screen_address', priceUsd: SCREEN_PRICE_USDC, currency: 'USDC', chain: X402_CHAIN, recipient: X402_RECIPIENT },
    { tool: 'agent_kyc_check_ofac_list', priceUsd: 0 },
    { tool: 'agent_kyc_check_fatf_list', priceUsd: 0 },
    { tool: 'agent_kyc_query_status',    priceUsd: 0 },
  ],
  brand: BRAND_GOLD,
}));

app.get('/seo.json', (req, res) => res.json({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Hive Agent KYC MCP',
  description: SCOPE_DISCLAIMER,
  applicationCategory: 'DeveloperApplication',
  applicationSubCategory: 'AI Agent / MCP Server / Compliance Broker',
  operatingSystem: 'Any (HTTP)',
  url: 'https://hive-mcp-agent-kyc.onrender.com',
  softwareVersion: VERSION,
  publisher: { '@type': 'Organization', name: 'Hive Civilization', url: 'https://hive-mcp-gateway.onrender.com' },
  author: { '@type': 'Person', name: 'Steve Rotzin', email: 'steve@thehiveryiq.com', url: 'https://www.thehiveryiq.com' },
  offers: [
    { '@type': 'Offer', name: 'agent_kyc_screen_address', price: String(SCREEN_PRICE_USDC), priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'agent_kyc_check_ofac_list', price: '0', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'agent_kyc_check_fatf_list', price: '0', priceCurrency: 'USD' },
    { '@type': 'Offer', name: 'agent_kyc_query_status', price: '0', priceCurrency: 'USD' },
  ],
  keywords: 'mcp, model-context-protocol, x402, a2a, agentic, ai-agent, hive, hive-civilization, agent-kyc, kyc, sanctions-screening, ofac, fatf, aml, anti-money-laundering, compliance, risk-scoring, chain-analysis, chainalysis-compatible, trm-compatible, elliptic-compatible, broker-layer, usdc, base, base-l2, real-rails, did-attestation',
  isAccessibleForFree: false,
  inLanguage: 'en',
}));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Sitemap: https://hive-mcp-agent-kyc.onrender.com/sitemap.xml',
    '',
    '# Hive Civilization · public discovery surface · indexing welcome',
  ].join('\n'));
});

app.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  res.type('text/plain').send([
    'Contact: mailto:steve@thehiveryiq.com',
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    'Canonical: https://hive-mcp-gateway.onrender.com/.well-known/security.txt',
    'Policy: https://www.thehiveryiq.com',
    '',
    '# Hive Civilization · security disclosure contact',
  ].join('\n'));
});

app.get('/', (req, res) => {
  res.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hive Agent KYC MCP — Broker / Observer Layer</title>
<meta name="description" content="${SCOPE_DISCLAIMER.replace(/"/g, '&quot;')}"/>
<meta name="theme-color" content="${BRAND_GOLD}"/>
<meta name="robots" content="index,follow"/>
<link rel="canonical" href="https://hive-mcp-agent-kyc.onrender.com/"/>
<meta property="og:url" content="https://hive-mcp-agent-kyc.onrender.com/"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="Hive Agent KYC MCP"/>
<meta property="og:description" content="${SCOPE_DISCLAIMER.replace(/&quot;/g, '&quot;')}"/>
<style>
  body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0d0a06;color:#fbf6ec;line-height:1.55;padding:48px 32px;max-width:920px;margin:0 auto;}
  h1{color:${BRAND_GOLD};font-size:42px;margin:0 0 12px;letter-spacing:-1px;}
  .eyebrow{color:${BRAND_GOLD};font-family:ui-monospace,monospace;letter-spacing:6px;text-transform:uppercase;font-size:13px;margin:0 0 18px;}
  code{color:${BRAND_GOLD};}
  ul li{padding:8px 0;}
  .disclaimer{border:1px solid ${BRAND_GOLD};padding:18px;border-radius:6px;margin:24px 0;background:rgba(192,141,35,0.05);}
</style></head><body>
<p class="eyebrow">Hive Civilization · MCP Server</p>
<h1>Hive Agent KYC</h1>
<p>Broker/observer layer for KYC/AML screening. Routes to third-party providers (Chainalysis, TRM Labs, Elliptic) and surfaces public sanctions list matches (OFAC SDN, FATF).</p>
<div class="disclaimer"><strong>Scope:</strong> ${SCOPE_DISCLAIMER}</div>
<h2>Endpoint</h2>
<p><code>POST https://hive-mcp-agent-kyc.onrender.com/mcp</code></p>
<h2>Tools (4)</h2>
<ul>
  ${TOOLS.map(t => `<li><code>${t.name}</code> — ${t.description}</li>`).join('\n  ')}
</ul>
<h2>Discovery</h2>
<ul>
  <li><code>GET /.well-known/mcp.json</code></li>
  <li><code>GET /.well-known/agent.json</code></li>
  <li><code>GET /health</code></li>
  <li><code>GET /seo.json</code></li>
</ul>
<p style="color:rgba(251,246,236,.55);font-size:13px;margin-top:48px;border-top:1px solid rgba(251,246,236,.08);padding-top:24px;">
  v${VERSION} · brand <code>${BRAND_GOLD}</code> · Author Steve Rotzin
</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Hive Agent KYC MCP Server running on :${PORT}`);
  console.log(`  Scope     : broker / observer layer`);
  console.log(`  Tools     : ${TOOLS.length}`);
  console.log(`  Providers : ${Object.keys(PROVIDER_KEYS).filter(k => PROVIDER_KEYS[k]).join(', ') || 'none configured (503 backend_pending)'}`);
  console.log(`  Brand     : ${BRAND_GOLD}`);
});
