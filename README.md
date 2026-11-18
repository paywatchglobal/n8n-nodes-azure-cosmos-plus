# @paywatchglobal/n8n-nodes-azure-cosmos-plus

n8n community node for Azure Cosmos DB (NoSQL) using the official SDK, built for keyless,
least-privilege access:

- **Entra app identity** — AKS workload identity, managed identity or an app registration,
  using Cosmos DB data-plane RBAC. No master keys, no personal refresh tokens.
- **One credential, many accounts** — the token audience (`https://cosmos.azure.com`) is
  account-agnostic, so the node takes the account per item (*Endpoint Override*) and one node
  can work across several accounts (e.g. one per country).
- **Safe writes** — point reads return `_etag`; *Replace* sends `If-Match` and fails with 412
  if the document changed since it was read.
- **Parameterised queries** — pass `@name` parameters instead of building SQL from inputs.

Derived from [wtyeung/n8n-nodes-azure-cosmos-sdk](https://github.com/wtyeung/n8n-nodes-azure-cosmos-sdk)
0.3.3 (MIT). Node and credential type names are different, so both packages can be installed side
by side.

## Installation

Install `@paywatchglobal/n8n-nodes-azure-cosmos-plus` as a community node
([guide](https://docs.n8n.io/integrations/community-nodes/installation/)) or bake it into the n8n
image.

## Operations

| Operation | Notes |
|---|---|
| Select | SQL query with optional **Query Parameters** (`[{"name":"@orderNo","value":"order-123"}]`) |
| Get by ID | Point read by ID + partition key. *If Not Found*: error or empty item |
| Replace | Full-document replace with `If-Match`. ETag defaults to the document's `_etag`; *Require ETag* refuses unconditional writes. Partition key is derived from the document when left empty |
| Insert / Create or Update / Delete | As upstream |
| Create / Delete Database, Create / Delete Container | As upstream (vector and full-text index options) |

## Credentials

### Azure Cosmos DB Plus (Entra App Identity) — recommended

| Field | |
|---|---|
| Identity Type | `Workload Identity (AKS)`, `Managed Identity` or `Client Secret` |
| Tenant ID / Client ID | Client ID of the user-assigned identity or app registration |
| Federated Token File | Optional; defaults to `AZURE_FEDERATED_TOKEN_FILE` |
| Default Endpoint | Used when the node has no *Endpoint Override* |
| Allowed Endpoints | Optional allowlist (URLs or account names). Empty = any `*.documents.azure.com` |

The identity needs a Cosmos DB **SQL role assignment** on each account (data-plane RBAC is per
account), e.g. `azurerm_cosmosdb_sql_role_assignment`, plus
`Microsoft.DocumentDB/databaseAccounts/readMetadata` at account scope. Who may use the identity in
n8n is controlled by who the credential is shared with.

For AKS workload identity, label the n8n pods `azure.workload.identity/use: "true"` and federate
the identity to the n8n service account.

### Azure Cosmos DB Plus (Master Key)

Account endpoint + key. Kept for migration; keys grant full account access.

## Usage

**Route by country** — set *Endpoint Override* to an expression:

```
{{ { MY: 'cosmos-app-my', ID: 'cosmos-app-id', PH: 'cosmos-app-ph' }[$json.country] }}
```

**Optimistic update** — *Get by ID* → modify in a Set/Code node → *Replace* (leave *If-Match ETag*
empty to use the document's `_etag`). Handle 412 with *On Error → Continue (using error output)*
and re-read.

## Compatibility

Built with `@n8n/node-cli` 0.31 and tested on Node 22. Requires n8n 1.x with community nodes
enabled.

## Development

```bash
npm ci
npm run lint && npx tsc --noEmit
npm run build && npm test
```

Releases: bump `version` in `package.json`, then create a GitHub release (`/release`); the
*Publish to npm* workflow publishes on release.
