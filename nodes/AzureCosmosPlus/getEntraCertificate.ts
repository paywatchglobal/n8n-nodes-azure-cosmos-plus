import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { certificateAuthenticates, parseBundle } from './certificate';
import type { AuthenticationType } from './client';

const CREDENTIAL = 'azureCosmosPlusAppIdentityApi';

/**
 * "Get Entra Certificate": triggers the credential's pre-authentication step (which generates,
 * rotates or promotes the certificate and persists it into the encrypted credential), then
 * returns the public certificate as a downloadable .cer file. The private key is never output.
 */
export async function getEntraCertificate(
	this: IExecuteFunctions,
	authenticationType: AuthenticationType,
	itemIndex: number,
): Promise<INodeExecutionData> {
	if (authenticationType !== 'appIdentity') {
		throw new NodeOperationError(
			this.getNode(),
			'"Get Entra Certificate" needs Authentication Type = Microsoft Entra ID (App Identity)',
			{ itemIndex },
		);
	}
	const creds = await this.getCredentials(CREDENTIAL, itemIndex);
	if (creds.identityType !== 'certificate') {
		throw new NodeOperationError(
			this.getNode(),
			'"Get Entra Certificate" only applies to credentials with Identity Type = Certificate',
			{ itemIndex },
		);
	}
	const tenantId = String(creds.tenantId ?? '').trim();
	const clientId = String(creds.clientId ?? '').trim();
	if (!tenantId || !clientId) {
		throw new NodeOperationError(
			this.getNode(),
			'Set Tenant ID and Client ID on the credential first',
			{
				itemIndex,
			},
		);
	}
	const nodeCredential = this.getNode().credentials?.[CREDENTIAL];
	if (!nodeCredential?.id) {
		throw new NodeOperationError(
			this.getNode(),
			'Save the credential before generating a certificate',
			{
				itemIndex,
			},
		);
	}

	// n8n runs the credential's preAuthentication before an authenticated request and persists
	// what it returns. Passing preAuthState = '' guarantees it runs. The request itself is a
	// harmless public read of the tenant's OpenID metadata.
	await this.helpers.httpRequestWithAuthentication.call(
		this,
		CREDENTIAL,
		{
			method: 'GET',
			url: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`,
			json: true,
		},
		{
			credentialsDecrypted: {
				id: nodeCredential.id,
				name: nodeCredential.name,
				type: CREDENTIAL,
				data: { ...creds, preAuthState: '' },
			},
		},
	);

	const bundle = parseBundle((await this.getCredentials(CREDENTIAL, itemIndex)).certificateBundle);
	if (!bundle.active) {
		throw new NodeOperationError(
			this.getNode(),
			'The certificate was not saved to the credential. Check that this n8n version supports credential pre-authentication.',
			{ itemIndex },
		);
	}

	// Upload the pending certificate during a rotation, otherwise the active one.
	const cert = bundle.pending ?? bundle.active;
	const registered = await certificateAuthenticates(tenantId, clientId, cert);
	const fileName = `cosmos-plus-${clientId}-${cert.thumbprintSha1.slice(0, 8).toLowerCase()}.cer`;
	const binary = await this.helpers.prepareBinaryData(
		Buffer.from(cert.certificatePem, 'utf8'),
		fileName,
		'application/x-x509-ca-cert',
	);

	const status = registered
		? 'registered'
		: bundle.pending
			? 'rotation pending: upload this certificate'
			: 'upload this certificate';

	return {
		json: {
			status,
			registeredInEntra: registered,
			rotationPending: Boolean(bundle.pending),
			activeThumbprintSha1: bundle.active.thumbprintSha1,
			thumbprintSha1: cert.thumbprintSha1,
			thumbprintSha256: cert.thumbprintSha256,
			subject: cert.subject,
			notBefore: cert.notBefore,
			notAfter: cert.notAfter,
			tenantId,
			clientId,
			fileName,
			nextSteps: registered
				? bundle.pending
					? 'Run "Get Entra Certificate" again to make the new certificate active.'
					: 'Nothing to do. If you rotated, remove the previous certificate from the app registration.'
				: `Download ${fileName} (Binary tab) and upload it in Entra: App registrations → ${clientId} → Certificates & secrets → Certificates → Upload certificate. Or: az ad app credential reset --id ${clientId} --cert @${fileName} --append`,
		},
		binary: { certificate: binary },
		pairedItem: itemIndex,
	};
}
