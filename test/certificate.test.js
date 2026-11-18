// Run with: npm run build && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { X509Certificate, createPrivateKey } = require('crypto');
const cert = require('../dist/nodes/AzureCosmosPlus/certificate.js');
const {
	AzureCosmosPlusAppIdentityApi,
} = require('../dist/credentials/AzureCosmosPlusAppIdentityApi.credentials.js');
const { getEntraCertificate } = require('../dist/nodes/AzureCosmosPlus/getEntraCertificate.js');

test('generated certificate is a valid RSA-3072 client-auth cert matching its key', () => {
	const c = cert.generateCertificate('n8n Azure Cosmos DB Plus test', 12);
	const x = new X509Certificate(c.certificatePem);
	assert.ok(x.checkPrivateKey(createPrivateKey(c.privateKeyPem)));
	assert.equal(x.subject, 'CN=n8n Azure Cosmos DB Plus test');
	assert.equal(x.issuer, x.subject);
	assert.equal(x.publicKey.asymmetricKeyDetails.modulusLength, 3072);
	assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.2']); // clientAuth
	assert.equal(x.ca, false);
	const days = (new Date(c.notAfter) - new Date(c.notBefore)) / 86_400_000;
	assert.ok(days > 360 && days < 370, `validity ${days} days`);
	assert.equal(c.thumbprintSha1.length, 40);
	assert.equal(c.thumbprintSha256.length, 64);
	assert.ok(!c.certificatePem.includes('PRIVATE KEY'));
});

test('validity is clamped to 1..60 months', () => {
	const long = cert.generateCertificate('x', 99);
	const days = (new Date(long.notAfter) - new Date(long.notBefore)) / 86_400_000;
	assert.ok(days > 1820 && days < 1830, `validity ${days} days`);
});

test('a 60-month certificate is valid for five years', () => {
	const c = cert.generateCertificate('x', 60);
	const days = (new Date(c.notAfter) - new Date(c.notBefore)) / 86_400_000;
	assert.ok(days > 1820 && days < 1830, `validity ${days} days`);
});

test('nextBundle: generate, rotate to pending, promote once Entra accepts it', async () => {
	const base = { tenantId: 't', clientId: 'c', validityMonths: 12, rotate: false };
	const first = await cert.nextBundle({ ...base, bundle: {} });
	assert.ok(first.active && !first.pending);

	const same = await cert.nextBundle({ ...base, bundle: first });
	assert.equal(same.active.thumbprintSha256, first.active.thumbprintSha256);

	const rotating = await cert.nextBundle({ ...base, rotate: true, bundle: first });
	assert.equal(rotating.active.thumbprintSha256, first.active.thumbprintSha256);
	assert.ok(
		rotating.pending && rotating.pending.thumbprintSha256 !== first.active.thumbprintSha256,
	);

	const notYet = await cert.nextBundle({ ...base, bundle: rotating }, async () => false);
	assert.ok(notYet.pending);

	const promoted = await cert.nextBundle({ ...base, bundle: rotating }, async () => true);
	assert.equal(promoted.active.thumbprintSha256, rotating.pending.thumbprintSha256);
	assert.equal(promoted.pending, undefined);
});

test('credential preAuthentication persists the bundle and resets the rotate flag', async () => {
	const credential = new AzureCosmosPlusAppIdentityApi();
	const out = await credential.preAuthentication.call(
		{},
		{ identityType: 'certificate', tenantId: 't', clientId: 'c', rotateOnNextRun: true },
	);
	assert.equal(out.preAuthState, '');
	assert.equal(out.rotateOnNextRun, false);
	assert.ok(cert.parseBundle(out.certificateBundle).active);

	assert.deepEqual(
		await credential.preAuthentication.call({}, { identityType: 'workloadIdentity' }),
		{ preAuthState: '' },
	);
	const props = Object.fromEntries(credential.properties.map((p) => [p.name, p]));
	assert.equal(props.certificateBundle.type, 'hidden');
	assert.equal(props.certificateBundle.typeOptions.password, true); // redacted before reaching the UI
	assert.equal(props.preAuthState.typeOptions.expirable, true);
	assert.ok(!credential.properties.some((p) => /secret/i.test(p.name)), 'no client secret field');
});

test('bundle credential prefers the pending cert and falls back to active', async () => {
	const bundle = await cert.nextBundle({
		tenantId: 't',
		clientId: 'c',
		validityMonths: 1,
		rotate: false,
		bundle: {},
	});
	bundle.pending = cert.generateCertificate('p', 1);
	const c = new cert.CertificateBundleCredential('t', 'c', bundle);
	let pendingCalls = 0;
	c.pending = {
		getToken: async () => {
			pendingCalls++;
			throw new Error('AADSTS700027');
		},
	};
	c.active = { getToken: async () => ({ token: 'active', expiresOnTimestamp: 1 }) };
	assert.equal((await c.getToken('s')).token, 'active');
	assert.equal((await c.getToken('s')).token, 'active');
	assert.equal(pendingCalls, 1, 'pending is not retried once it failed');

	assert.throws(() => new cert.CertificateBundleCredential('t', 'c', {}), /Get Entra Certificate/);
});

test('Get Entra Certificate generates via preAuthentication and outputs only the public cert', async () => {
	const credentialType = new AzureCosmosPlusAppIdentityApi();
	let stored = { identityType: 'certificate', tenantId: 'tenant-1', clientId: 'client-1' };
	let requested;
	const origCheck = cert.certificateAuthenticates;
	cert.certificateAuthenticates = async () => false;
	try {
		const ctx = {
			getNode: () => ({
				name: 'Cosmos',
				credentials: { azureCosmosPlusAppIdentityApi: { id: '42', name: 'cosmos app' } },
			}),
			getCredentials: async () => ({ ...stored }),
			helpers: {
				// What n8n does: run preAuthentication when the expirable field is '', persist the output.
				httpRequestWithAuthentication: async function (type, options, extra) {
					assert.equal(type, 'azureCosmosPlusAppIdentityApi');
					assert.equal(extra.credentialsDecrypted.data.preAuthState, '');
					requested = options.url;
					const output = await credentialType.preAuthentication.call(
						{},
						extra.credentialsDecrypted.data,
					);
					stored = { ...stored, ...output };
					return {};
				},
				prepareBinaryData: async (buffer, fileName, mimeType) => ({
					data: buffer.toString('base64'),
					fileName,
					mimeType,
				}),
			},
		};
		const out = await getEntraCertificate.call(ctx, 'appIdentity', 0);
		assert.match(requested, /login\.microsoftonline\.com\/tenant-1\/v2\.0\/\.well-known/);
		assert.equal(out.json.status, 'upload this certificate');
		assert.equal(out.json.registeredInEntra, false);
		const pem = Buffer.from(out.binary.certificate.data, 'base64').toString();
		assert.match(pem, /BEGIN CERTIFICATE/);
		assert.ok(!pem.includes('PRIVATE KEY'));
		assert.ok(!JSON.stringify(out.json).includes('PRIVATE KEY'));
		assert.match(out.binary.certificate.fileName, /^cosmos-plus-client-1-[0-9a-f]{8}\.cer$/);

		// second run keeps the same certificate
		const again = await getEntraCertificate.call(ctx, 'appIdentity', 0);
		assert.equal(again.json.thumbprintSha256, out.json.thumbprintSha256);

		await assert.rejects(getEntraCertificate.call(ctx, 'masterKey', 0), /App Identity/);
		stored.identityType = 'workloadIdentity';
		await assert.rejects(
			getEntraCertificate.call(ctx, 'appIdentity', 0),
			/Identity Type = Certificate/,
		);
	} finally {
		cert.certificateAuthenticates = origCheck;
	}
});
