# v1.0.0 — Hive Agent KYC MCP Server

Initial release of the Hive Civilization compliance-broker MCP server.

## Scope

Broker / observer layer only. Routes screening requests to third-party KYC/AML providers and surfaces public sanctions list matches. **Not** a regulated money-services business. Does not hold custody of KYC documents, does not make final allow/deny determinations, and does not issue compliance attestations on behalf of regulated entities. Final compliance determinations remain with the requesting agent and its operator.

## Tools (4)

| Tool | Cost | Description |
|---|---|---|
| `agent_kyc_screen_address` | $0.10 USDC on Base | Route to Chainalysis / TRM Labs / Elliptic. Returns provider response verbatim. |
| `agent_kyc_check_ofac_list` | free | Match against OFAC SDN public list (cached 24h from treasury.gov). |
| `agent_kyc_check_fatf_list` | free | Match against FATF Call-for-Action + Increased-Monitoring lists. |
| `agent_kyc_query_status` | free | Read audit-log entry by `query_id`. No PII. |

## Settlement

- Recipient: `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` (Wallet 1)
- Chain: Base L2
- Asset: USDC
- Real rails. No mock. No simulated.

## Backend status

Third-party provider partnership keys pending. Until configured, `agent_kyc_screen_address` returns 503 with `backend_pending: true`. Public-list tools (`agent_kyc_check_ofac_list`, `agent_kyc_check_fatf_list`) return real data today.

## Doctrine

This server is the CLEAN-MONEY gate primitive in the Hive Civilization three-gate doctrine (NEED + YIELD + CLEAN-MONEY). Other Hive surfaces call this before settling.

## Council provenance

Ad-hoc — Tier B underplayed-vertical build, broker scope confirmed by user.

## Brand

Pantone 1245 C / `#C08D23`.
