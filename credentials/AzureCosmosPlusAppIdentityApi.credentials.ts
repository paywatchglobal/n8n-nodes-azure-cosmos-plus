import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * App-only Entra ID credential for Cosmos DB data-plane RBAC.
 *
 * Authenticates as an application identity (not a person's delegated token), so writes
 * are attributed to the app, never expire with a person's session, and need no stored
 * secret when Workload Identity is used on AKS.
 *
 * The token audience (https://cosmos.azure.com) is account-agnostic: one identity can
 * reach every Cosmos account it has a data-plane role assignment on. The endpoint here
 * is only a default; nodes can override it per item (see "Endpoint Override").
 *
 * Who may use the identity is controlled by who this credential is shared with in n8n:
 * the client ID is not usable from Code nodes, only through nodes that accept this
 * credential.
 */
export class AzureCosmosPlusAppIdentityApi implements ICredentialType {
	icon = { light: 'file:cosmos.svg', dark: 'file:cosmos.dark.svg' } as const;
	name = 'azureCosmosPlusAppIdentityApi';
	displayName = 'Azure Cosmos DB Plus (Entra App Identity) API';
	documentationUrl =
		'https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/security/how-to-grant-data-plane-role-based-access';
	properties: INodeProperties[] = [
		{
			displayName: 'Identity Type',
			name: 'identityType',
			type: 'options',
			options: [
				{
					name: 'Workload Identity (AKS)',
					value: 'workloadIdentity',
					description:
						'Federated user-assigned managed identity. Uses AZURE_FEDERATED_TOKEN_FILE injected by the AKS workload identity webhook. No secret stored.',
				},
				{
					name: 'Managed Identity',
					value: 'managedIdentity',
					description: 'User-assigned managed identity via IMDS (VM, App Service, Container Apps)',
				},
				{
					name: 'Client Secret',
					value: 'clientSecret',
					description:
						'App registration with a client secret (local development / non-Azure hosts)',
				},
			],
			default: 'workloadIdentity',
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { identityType: ['workloadIdentity', 'clientSecret'] } },
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description:
				'Client ID of the user-assigned managed identity or app registration. Several identities can be federated to the same Kubernetes service account; this picks which one.',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: { show: { identityType: ['clientSecret'] } },
		},
		{
			displayName: 'Federated Token File',
			name: 'tokenFilePath',
			type: 'string',
			default: '',
			placeholder: '/var/run/secrets/azure/tokens/azure-identity-token',
			description: 'Leave empty to use AZURE_FEDERATED_TOKEN_FILE from the pod environment',
			displayOptions: { show: { identityType: ['workloadIdentity'] } },
			typeOptions: { password: true },
		},
		{
			displayName: 'Default Endpoint',
			name: 'endpoint',
			type: 'string',
			default: '',
			placeholder: 'https://your-account.documents.azure.com:443/',
			description:
				'Used when a node does not set "Endpoint Override". Optional if every node supplies its own endpoint.',
		},
		{
			displayName: 'Allowed Endpoints',
			name: 'allowedEndpoints',
			type: 'string',
			default: '',
			placeholder:
				'https://cosmos-app-my.documents.azure.com, https://cosmos-app-id.documents.azure.com',
			description:
				'Comma-separated allowlist of account endpoints (or bare account names) this credential may connect to. Empty = any *.documents.azure.com account (RBAC still applies).',
		},
	];
}
