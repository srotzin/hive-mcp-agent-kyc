<!-- HIVE_BANNER_V1 -->
<p align="center">
  <a href="https://hive-mcp-gateway.onrender.com/agent-kyc/health">
    <img src="https://hive-mcp-gateway.onrender.com/og.svg" alt="Hive Civilization MCP Gateway · broker / observer layer · CLEAN-MONEY gate" width="100%"/>
  </a>
</p>

<h1 align="center">hive-mcp-agent-kyc</h1>

<p align="center"><strong>Broker / observer layer for KYC/AML screening · CLEAN-MONEY gate primitive</strong></p>

<p align="center">
  <a href="https://smithery.ai/server/hivecivilization/hive-mcp-agent-kyc"><img alt="Smithery" src="https://img.shields.io/badge/Smithery-hivecivilization%2Fhive--mcp--agent--kyc-C08D23?style=flat-square"/></a>
  <a href="https://glama.ai/mcp/servers"><img alt="Glama" src="https://img.shields.io/badge/Glama-pending-C08D23?style=flat-square"/></a>
  <a href="https://hive-mcp-gateway.onrender.com/agent-kyc/health"><img alt="Live" src="https://img.shields.io/badge/gateway-live-C08D23?style=flat-square"/></a>
  <a href="https://github.com/srotzin/hive-mcp-agent-kyc/releases"><img alt="Release" src="https://img.shields.io/github/v/release/srotzin/hive-mcp-agent-kyc?style=flat-square&color=C08D23"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-C08D23?style=flat-square"/></a>
</p>

<p align="center">
  <code>https://hive-mcp-gateway.onrender.com/agent-kyc/mcp</code>
</p>

---

## Scope disclaimer

> Hive Agent KYC is a broker/observer layer. It routes screening requests to third-party providers and surfaces public sanctions list matches. It is not a regulated money-services business, does not make custody, lending, or transaction-permitting decisions, and does not issue compliance attestations on behalf of regulated entities. Final compliance determinations remain with the requesting agent and its operator.

This disclaimer is also surfaced verbatim in every tool's response payload, in `/.well-known/agent.json`, and in the JSON-LD `description`.

---

## What this is

`hive-mcp-agent-kyc` is a Model Context Protocol (MCP) server that any MCP-compatible client (Claude Desktop, Cursor, Manus, agent runtimes) can call to:

1. Route a blockchain address screening request to one of three third-party KYC/AML providers — Chainalysis, TRM Labs, or Elliptic — and return the provider's risk score and flags **verbatim** (no enrichment, no Hive scoring layer).
2. Check public sanctions list matches against the OFAC SDN list and the FATF high-risk-jurisdiction lists.
3. Read back an audit-log entry for a prior query (DID + timestamp + provider + result code only — no PII).

What this **does not** do:

- It does not hold custody of any KYC documents.
- It does not make a final allow/deny determination on a transaction.
- It does not issue an attestation that a person/entity is "KYC'd by Hive".
- It does not operate as a money-services business.

The purpose is to be the **CLEAN-MONEY gate primitive** that other Hive surfaces (Vault, Trade, Swap, Treasury) can call before settling. Compliance determinations remain with the calling operator.

- **Protocol**: MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0
- **Transport**: `POST /mcp`
- **Discovery**: `GET /.well-known/mcp.json`, `GET /.well-known/agent.json`
- **Health**: `GET /health`
- **Settlement**: real x402 — USDC on Base L2 to wallet `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`. No mock. No simulated.
- **Backend status**: provider partnership keys pending — `agent_kyc_screen_address` returns 503 with `backend_pending: true` until configured. Public list tools (OFAC, FATF) return real data today.
- **Brand gold**: Pantone 1245 C / `#C08D23`

---

## Tools

| Tool | Cost | Description |
|---|---|---|
| `agent_kyc_screen_address` | $0.10 USDC (Base) | Route screening request to Chainalysis / TRM Labs / Elliptic. Returns provider response verbatim. 503 `backend_pending` until keys configured. |
| `agent_kyc_check_ofac_list` | free | Check identifier against OFAC SDN public list. Cached 24h. |
| `agent_kyc_check_fatf_list` | free | Check ISO-3166 country code against FATF Call-for-Action and Increased-Monitoring lists. |
| `agent_kyc_query_status` | free | Read prior audit-log entry by `query_id`. Returns DID + timestamp + provider + result code + address hash. No PII. |

### `agent_kyc_screen_address`

```json
{
  "name": "agent_kyc_screen_address",
  "arguments": {
    "address": "0x...",
    "chain": "base",
    "provider": "chainalysis",
    "requester_did": "did:hive:agent-vault"
  }
}
```

Until partnership keys are configured, returns:

```json
{
  "ok": false,
  "status": 503,
  "backend_pending": true,
  "message": "Third-party screening backend not yet configured...",
  "x402": {
    "recipient": "0x15184bf50b3d3f52b60434f8942b7d52f2eb436e",
    "chain": "base",
    "asset": "USDC",
    "amount_usdc": 0.10
  }
}
```

### `agent_kyc_check_ofac_list`

```json
{
  "name": "agent_kyc_check_ofac_list",
  "arguments": { "identifier": "0x...", "identifier_type": "address" }
}
```

Returns the cache age, source URL (treasury.gov), and a deterministic match flag against the cached SDN list.

### `agent_kyc_check_fatf_list`

```json
{
  "name": "agent_kyc_check_fatf_list",
  "arguments": { "country_code": "IR" }
}
```

Returns category (`call_for_action` | `increased_monitoring` | `not_listed`) + FATF source URL.

### `agent_kyc_query_status`

```json
{
  "name": "agent_kyc_query_status",
  "arguments": { "query_id": "..." }
}
```

---

## Audit log

The audit log stores **only** these fields per query, in memory:

- `query_id` (UUID)
- `did` (requesting agent's DID)
- `ts` (ISO-8601 timestamp)
- `provider` (`chainalysis` | `trm` | `elliptic` | `ofac_public` | `fatf_public`)
- `result_code` (HTTP status returned)
- `address_hash` (first 16 hex chars of SHA-256 of lowercase identifier)

Raw addresses, names, and PII are never stored. Operators wanting durable logs route them to their own SIEM via webhook (not a Hive responsibility).

---

## Connect

### Claude Desktop

```json
{
  "mcpServers": {
    "hive-agent-kyc": {
      "url": "https://hive-mcp-gateway.onrender.com/agent-kyc/mcp"
    }
  }
}
```

### Cursor / Manus / generic MCP client

Point your client at:

```
https://hive-mcp-gateway.onrender.com/agent-kyc/mcp
```

Streamable-HTTP transport, JSON-RPC 2.0, MCP 2024-11-05.

### Local

```bash
git clone https://github.com/srotzin/hive-mcp-agent-kyc
cd hive-mcp-agent-kyc
npm install
node server.js
# server runs on :3000
```

To enable the screening provider routing locally, set any of:

```bash
export CHAINALYSIS_API_KEY=...
export TRM_API_KEY=...
export ELLIPTIC_API_KEY=...
```

When no key is set, `agent_kyc_screen_address` returns 503 `backend_pending`. The OFAC and FATF tools work without keys.

---

## Settlement

Real x402 rails. The screening tool quotes:

```
recipient : 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
chain     : Base L2
asset     : USDC
amount    : $0.10 USDC per screen call
```

No mock. No simulated. No testnet pretending to be mainnet. While the screening backend is in `backend_pending`, no charge is applied — the x402 quote is informational so calling agents can pre-flight payment configuration.

---

## Hive doctrine context

This server is the **CLEAN-MONEY gate** primitive in the Hive Civilization three-gate doctrine (NEED + YIELD + CLEAN-MONEY). Any other Hive surface that touches settlement is expected to call `agent_kyc_screen_address` and the public-list tools before clearing.

It is intentionally a thin broker: enrichment, scoring, and final decision remain with the third-party provider and the operator, respectively. Hive does not become a regulated MSB by routing.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  <code style="color:#C08D23">#C08D23</code> · Hive Civilization · 2026
</p>
