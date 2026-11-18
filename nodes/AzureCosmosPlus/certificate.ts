import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes } from 'crypto';
import forge from 'node-forge';
import { ClientCertificateCredential } from '@azure/identity';
import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth';

/** A certificate generated for an Entra app registration. The private key never leaves the credential. */
export interface StoredCertificate {
	privateKeyPem: string;
	certificatePem: string;
	thumbprintSha1: string;
	thumbprintSha256: string;
	subject: string;
	notBefore: string;
	notAfter: string;
	createdAt: string;
}

/**
 * `active` is the certificate in use. `pending` is a rotation in progress: generated, waiting to
 * be uploaded to Entra. While it exists, tokens are requested with `pending` first and fall back
 * to `active`, so rotation has no downtime. Running "Get Entra Certificate" again after upload
 * promotes `pending` to `active`.
 */
export interface CertificateBundle {
	active?: StoredCertificate;
	pending?: StoredCertificate;
}

export const COSMOS_SCOPE = 'https://cosmos.azure.com/.default';

export function parseBundle(raw: unknown): CertificateBundle {
	if (!raw || typeof raw !== 'string') return {};
	try {
		const parsed = JSON.parse(raw) as CertificateBundle;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

export function serializeBundle(bundle: CertificateBundle): string {
	return JSON.stringify(bundle);
}

function colonHex(hex: string): string {
	return hex.replace(/:/g, '').toUpperCase();
}

export const MAX_VALIDITY_MONTHS = 60;

/**
 * Generate a self-signed RSA-3072 / SHA-256 client-auth certificate. Entra accepts RSA keys only;
 * 3072 bits keeps a certificate of up to MAX_VALIDITY_MONTHS within NIST SP 800-57 past 2030.
 * Key generation uses Node's native crypto; node-forge only assembles and signs the X.509 structure.
 */
export function generateCertificate(commonName: string, validityMonths: number): StoredCertificate {
	const months = Math.min(Math.max(Math.floor(validityMonths) || 12, 1), MAX_VALIDITY_MONTHS);
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 3072,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const notBefore = new Date(Date.now() - 5 * 60 * 1000); // tolerate clock skew
	const notAfter = new Date(notBefore);
	notAfter.setMonth(notAfter.getMonth() + months);

	const cert = forge.pki.createCertificate();
	cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
	// Positive 16-byte serial (leading 0x01 keeps it positive in DER).
	cert.serialNumber = '01' + randomBytes(15).toString('hex');
	cert.validity.notBefore = notBefore;
	cert.validity.notAfter = notAfter;
	const attrs = [{ name: 'commonName', value: commonName.slice(0, 64) }];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.setExtensions([
		{ name: 'basicConstraints', cA: false, critical: true },
		{ name: 'keyUsage', digitalSignature: true, critical: true },
		{ name: 'extKeyUsage', clientAuth: true },
		{ name: 'subjectKeyIdentifier' },
	]);
	cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
	const certificatePem = forge.pki.certificateToPem(cert);

	const x509 = new X509Certificate(certificatePem);
	if (!x509.checkPrivateKey(createPrivateKey(privateKey))) {
		throw new Error('Generated certificate does not match its private key');
	}

	return {
		privateKeyPem: privateKey,
		certificatePem,
		thumbprintSha1: colonHex(x509.fingerprint),
		thumbprintSha256: colonHex(x509.fingerprint256),
		subject: x509.subject,
		notBefore: new Date(x509.validFrom).toISOString(),
		notAfter: new Date(x509.validTo).toISOString(),
		createdAt: new Date().toISOString(),
	};
}

export function certificateCredential(
	tenantId: string,
	clientId: string,
	cert: StoredCertificate,
): ClientCertificateCredential {
	return new ClientCertificateCredential(tenantId, clientId, {
		certificate: `${cert.privateKeyPem}\n${cert.certificatePem}`,
	});
}

/** True if Entra accepts this certificate for the app registration. */
export async function certificateAuthenticates(
	tenantId: string,
	clientId: string,
	cert: StoredCertificate,
): Promise<boolean> {
	try {
		await certificateCredential(tenantId, clientId, cert).getToken(COSMOS_SCOPE);
		return true;
	} catch {
		return false;
	}
}

/**
 * Tries the pending certificate first (if any) and falls back to the active one, remembering
 * which worked so later calls go straight to it.
 */
export class CertificateBundleCredential implements TokenCredential {
	private readonly active?: TokenCredential;
	private readonly pending?: TokenCredential;
	private pendingWorks?: boolean;

	constructor(tenantId: string, clientId: string, bundle: CertificateBundle) {
		if (!bundle.active) {
			throw new Error(
				'No certificate yet: run the node\'s "Get Entra Certificate" operation once, then upload the downloaded .cer to the app registration',
			);
		}
		this.active = certificateCredential(tenantId, clientId, bundle.active);
		if (bundle.pending) this.pending = certificateCredential(tenantId, clientId, bundle.pending);
	}

	async getToken(
		scopes: string | string[],
		options?: GetTokenOptions,
	): Promise<AccessToken | null> {
		if (this.pending && this.pendingWorks !== false) {
			try {
				const token = await this.pending.getToken(scopes, options);
				this.pendingWorks = true;
				return token;
			} catch (error) {
				if (this.pendingWorks === true) throw error;
				this.pendingWorks = false;
			}
		}
		return await this.active!.getToken(scopes, options);
	}
}

/**
 * Credential pre-authentication step: runs when the node's "Get Entra Certificate" operation is
 * executed, and its result is persisted (encrypted) into the n8n credential.
 *  - no certificate yet           -> generate the active certificate
 *  - rotateCertificate is on      -> generate a pending certificate, switch the flag off
 *  - pending accepted by Entra    -> promote it to active
 */
export async function nextBundle(
	creds: {
		tenantId: string;
		clientId: string;
		validityMonths: number;
		rotate: boolean;
		bundle: CertificateBundle;
	},
	check: typeof certificateAuthenticates = certificateAuthenticates,
): Promise<CertificateBundle> {
	const bundle: CertificateBundle = { ...creds.bundle };
	const cn = `n8n Azure Cosmos DB Plus ${creds.clientId}`;
	if (!bundle.active) {
		bundle.active = generateCertificate(cn, creds.validityMonths);
		delete bundle.pending;
	} else if (creds.rotate) {
		bundle.pending = generateCertificate(cn, creds.validityMonths);
	} else if (bundle.pending && (await check(creds.tenantId, creds.clientId, bundle.pending))) {
		bundle.active = bundle.pending;
		delete bundle.pending;
	}
	return bundle;
}
