import type {
	ICredentialDataDecryptedObject,
	ICredentialType,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

import { nextBundle, parseBundle, serializeBundle } from '../nodes/AzureCosmosPlus/certificate';

/**
 * App-only Entra ID credential for Cosmos DB data-plane RBAC.
 *
 * Authenticates as an application identity (not a person's delegated token), so writes are
 * attributed to the app and never expire with a person's session.
 *
 * Certificate identity: n8n generates the key pair itself. The private key is stored only in
 * this (encrypted) credential and is never shown in the UI; the node's "Get Entra Certificate"
 * operation outputs the public certificate as a downloadable file for upload to the app
 * registration. There is deliberately no client-secret option.
 *
 * The token audience (https://cosmos.azure.com) is account-agnostic: one identity can reach
 * every Cosmos account it has a data-plane role assignment on. The endpoint here is only a
 * default; nodes can override it per item (see "Endpoint Override").
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
					name: 'Certificate (App Registration)',
					value: 'certificate',
					description:
						'App registration authenticated with a certificate that n8n generates. Download it with the node\'s "Get Entra Certificate" operation and upload it to Entra.',
				},
				{
					name: 'Managed Identity',
					value: 'managedIdentity',
					description: 'User-assigned managed identity via IMDS (VM, App Service, Container Apps)',
				},
				{
					name: 'Workload Identity (AKS)',
					value: 'workloadIdentity',
					description:
						'Federated user-assigned managed identity. Uses AZURE_FEDERATED_TOKEN_FILE injected by the AKS workload identity webhook. No secret stored.',
				},
			],
			default: 'certificate',
		},
		{
			displayName:
				'After saving: add an Azure Cosmos DB Plus node using this credential, run its "Get Entra Certificate" operation once, download the .cer file from the output and upload it to the app registration (Certificates & secrets → Certificates → Upload certificate). The private key never leaves n8n.',
			name: 'setupNotice',
			type: 'notice',
			default: '',
			displayOptions: { show: { identityType: ['certificate'] } },
		},
		{
			displayName: 'Tenant ID',
			name: 'tenantId',
			type: 'string',
			default: '',
			required: true,
			displayOptions: { show: { identityType: ['certificate', 'workloadIdentity'] } },
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description:
				'Application (client) ID of the app registration, or client ID of the user-assigned managed identity',
		},
		{
			displayName: 'Certificate Validity (Months)',
			name: 'certificateValidityMonths',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 24 },
			default: 12,
			description: 'Validity of certificates generated for this credential',
			displayOptions: { show: { identityType: ['certificate'] } },
		},
		{
			displayName: 'Rotate Certificate',
			name: 'rotateOnNextRun',
			type: 'boolean',
			default: false,
			description:
				'Whether to generate a new certificate the next time "Get Entra Certificate" runs. The current certificate keeps working until the new one is uploaded; run "Get Entra Certificate" again after uploading to make it active, then remove the old certificate from Entra.',
			displayOptions: { show: { identityType: ['certificate'] } },
		},
		{
			displayName: 'Federated Token File',
			name: 'federatedFilePath',
			type: 'string',
			default: '',
			placeholder: '/var/run/secrets/azure/tokens/azure-identity-token',
			description: 'Leave empty to use AZURE_FEDERATED_TOKEN_FILE from the pod environment',
			displayOptions: { show: { identityType: ['workloadIdentity'] } },
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
			placeholder: 'https://cosmos-app-my.documents.azure.com, cosmos-app-ph',
			description:
				'Comma-separated allowlist of account endpoints (or bare account names) this credential may connect to. Empty = any *.documents.azure.com account (RBAC still applies).',
		},
		// Generated key material: hidden, and redacted by n8n before credential data reaches the
		// browser (typeOptions.password), restored from the stored value on save.
		{
			displayName: 'Certificate Bundle',
			name: 'certificateBundle',
			type: 'hidden',
			typeOptions: { password: true },
			default: '',
		},
		// Marks this credential as having a pre-authentication step. Kept empty on purpose.
		{
			displayName: 'Certificate State',
			name: 'preAuthState',
			type: 'hidden',
			typeOptions: { expirable: true },
			default: '',
		},
	];

	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
		if (credentials.identityType !== 'certificate') {
			return { preAuthState: '' };
		}
		const bundle = await nextBundle({
			tenantId: String(credentials.tenantId ?? '').trim(),
			clientId: String(credentials.clientId ?? '').trim(),
			validityMonths: Number(credentials.certificateValidityMonths) || 12,
			rotate: credentials.rotateOnNextRun === true,
			bundle: parseBundle(credentials.certificateBundle),
		});
		return {
			certificateBundle: serializeBundle(bundle),
			rotateOnNextRun: false,
			preAuthState: '',
		};
	}
}
