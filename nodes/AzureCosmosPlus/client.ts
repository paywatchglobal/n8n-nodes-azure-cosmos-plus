import type {
	ICredentialDataDecryptedObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { CosmosClient } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import { ManagedIdentityCredential, WorkloadIdentityCredential } from '@azure/identity';

import { CertificateBundleCredential, parseBundle } from './certificate';

export type AuthenticationType = 'appIdentity' | 'masterKey';

export const CREDENTIAL_NAMES: Record<AuthenticationType, string> = {
	appIdentity: 'azureCosmosPlusAppIdentityApi',
	masterKey: 'azureCosmosPlusKeyApi',
};

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

const ACCOUNT_HOST = /^[a-z0-9][a-z0-9-]{1,48}\.documents\.azure\.com$/;
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;

/**
 * Normalise an endpoint to `https://<host>:<port>/`. Accepts a full URL or a bare
 * account name (`cosmos-app-ph` -> `https://cosmos-app-ph.documents.azure.com:443/`).
 */
export function normalizeEndpoint(raw: string): string {
	const value = (raw || '').trim();
	if (!value) throw new Error('Cosmos endpoint is empty');
	if (ACCOUNT_NAME.test(value)) return `https://${value}.documents.azure.com:443/`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid Cosmos endpoint "${value}"`);
	}
	if (url.protocol !== 'https:') throw new Error(`Cosmos endpoint must use https: "${value}"`);
	const port = url.port || '443';
	return `https://${url.hostname.toLowerCase()}:${port}/`;
}

/**
 * Decide which endpoint a call may use.
 * - An override (from the node, possibly per item / from workflow input) must be a
 *   *.documents.azure.com account, and must be on the credential's allowlist if it has one.
 * - Without an override the credential's own endpoint is used as configured (legacy behaviour).
 */
export function resolveEndpoint(
	override: string | undefined,
	credentialEndpoint: string | undefined,
	allowedEndpoints: string | undefined,
): string {
	const allow = (allowedEndpoints || '')
		.split(',')
		.map((e) => e.trim())
		.filter(Boolean)
		.map(normalizeEndpoint);

	if (override && override.trim()) {
		const endpoint = normalizeEndpoint(override);
		const host = new URL(endpoint).hostname;
		if (allow.length > 0) {
			if (!allow.includes(endpoint)) {
				throw new Error(`Endpoint ${endpoint} is not in this credential's Allowed Endpoints`);
			}
		} else if (!ACCOUNT_HOST.test(host)) {
			throw new Error(
				`Endpoint override ${endpoint} is not a *.documents.azure.com account (add it to Allowed Endpoints to permit it)`,
			);
		}
		return endpoint;
	}

	if (!credentialEndpoint || !credentialEndpoint.trim()) {
		throw new Error(
			'No endpoint: set "Endpoint Override" on the node or "Default Endpoint" on the credential',
		);
	}
	const endpoint = normalizeEndpoint(credentialEndpoint);
	if (allow.length > 0 && !allow.includes(endpoint)) {
		throw new Error(`Endpoint ${endpoint} is not in this credential's Allowed Endpoints`);
	}
	return endpoint;
}

// One TokenCredential per identity for the life of the process: @azure/identity caches
// and refreshes tokens internally, so we don't re-acquire a token on every execution.
const tokenCredentialCache = new Map<string, TokenCredential>();

export function getAppTokenCredential(creds: ICredentialDataDecryptedObject): TokenCredential {
	const identityType = (creds.identityType as string) || 'certificate';
	const tenantId = ((creds.tenantId as string) || '').trim();
	const clientId = ((creds.clientId as string) || '').trim();
	const tokenFilePath = ((creds.federatedFilePath as string) || '').trim();
	if (!clientId) throw new Error('Client ID is required');

	const bundle = identityType === 'certificate' ? parseBundle(creds.certificateBundle) : {};
	const key = [
		identityType,
		tenantId,
		clientId,
		tokenFilePath,
		bundle.active?.thumbprintSha256 ?? '',
		bundle.pending?.thumbprintSha256 ?? '',
	].join('|');
	const cached = tokenCredentialCache.get(key);
	if (cached) return cached;

	let credential: TokenCredential;
	switch (identityType) {
		case 'certificate':
			if (!tenantId) throw new Error('Tenant ID is required for certificate authentication');
			credential = new CertificateBundleCredential(tenantId, clientId, bundle);
			break;
		case 'workloadIdentity': {
			if (!tenantId) throw new Error('Tenant ID is required for Workload Identity');
			const file = tokenFilePath || process.env.AZURE_FEDERATED_TOKEN_FILE;
			if (!file) {
				throw new Error(
					'No federated token file: AZURE_FEDERATED_TOKEN_FILE is not set (is the pod labelled azure.workload.identity/use: "true"?)',
				);
			}
			credential = new WorkloadIdentityCredential({ tenantId, clientId, tokenFilePath: file });
			break;
		}
		case 'managedIdentity':
			credential = new ManagedIdentityCredential({ clientId });
			break;
		default:
			throw new Error(`Unsupported identity type "${identityType}"`);
	}
	tokenCredentialCache.set(key, credential);
	return credential;
}

// --- Client factory ------------------------------------------------------------------

/**
 * Builds Cosmos clients for one node run. Credentials are loaded once; clients are cached
 * per endpoint, so items that target different accounts (e.g. MY / ID / PH) reuse one
 * client per account.
 */
export class CosmosClientFactory {
	private readonly clients = new Map<string, CosmosClient>();

	private constructor(
		readonly authenticationType: AuthenticationType,
		private readonly creds: ICredentialDataDecryptedObject,
	) {}

	static async create(
		ctx: Ctx,
		authenticationType: AuthenticationType,
	): Promise<CosmosClientFactory> {
		const credentialName = CREDENTIAL_NAMES[authenticationType];
		if (!credentialName) throw new Error(`Unknown authentication type "${authenticationType}"`);
		const creds = await ctx.getCredentials(credentialName);
		return new CosmosClientFactory(authenticationType, creds);
	}

	resolveEndpoint(override?: string): string {
		return resolveEndpoint(
			override,
			this.creds.endpoint as string | undefined,
			this.creds.allowedEndpoints as string | undefined,
		);
	}

	async get(override?: string): Promise<{ client: CosmosClient; endpoint: string }> {
		const endpoint = this.resolveEndpoint(override);
		const existing = this.clients.get(endpoint);
		if (existing) return { client: existing, endpoint };

		let client: CosmosClient;
		switch (this.authenticationType) {
			case 'masterKey':
				client = new CosmosClient({ endpoint, key: this.creds.key as string });
				break;
			case 'appIdentity':
				client = new CosmosClient({ endpoint, aadCredentials: getAppTokenCredential(this.creds) });
				break;
		}
		this.clients.set(endpoint, client);
		return { client, endpoint };
	}
}

/** Client for the editor's dropdowns: uses the endpoint override only when it is a literal, not an expression. */
export async function getLoadOptionsClient(ctx: ILoadOptionsFunctions): Promise<CosmosClient> {
	const authenticationType = ctx.getNodeParameter('authenticationType', 0) as AuthenticationType;
	const factory = await CosmosClientFactory.create(ctx, authenticationType);
	let override = '';
	try {
		const raw = ctx.getCurrentNodeParameter('endpointOverride');
		if (typeof raw === 'string' && !raw.startsWith('=')) override = raw;
	} catch {
		// parameter not present on this node
	}
	return (await factory.get(override)).client;
}
