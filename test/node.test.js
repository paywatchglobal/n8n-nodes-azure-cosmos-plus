// Run with: npm run build && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const cosmos = require('@azure/cosmos');
const {
	normalizeEndpoint,
	resolveEndpoint,
	CosmosClientFactory,
	getAppTokenCredential,
} = require('../dist/nodes/AzureCosmosPlus/client.js');
const { AzureCosmosPlus } = require('../dist/nodes/AzureCosmosPlus/AzureCosmosPlus.node.js');

const MY = 'https://cosmos-app-my.documents.azure.com:443/';
const PH = 'https://cosmos-app-ph.documents.azure.com:443/';

test('normalizeEndpoint accepts URLs and bare account names', () => {
	assert.equal(normalizeEndpoint('cosmos-app-ph'), PH);
	assert.equal(normalizeEndpoint('https://COSMOS-APP-PH.documents.azure.com'), PH);
	assert.equal(
		normalizeEndpoint('https://cosmos-app-ph.documents.azure.com:443/'),
		PH,
	);
	assert.throws(
		() => normalizeEndpoint('http://cosmos-app-ph.documents.azure.com'),
		/https/,
	);
	assert.throws(() => normalizeEndpoint(''), /empty/);
});

test('resolveEndpoint: override must be a Cosmos account and on the allowlist', () => {
	assert.equal(resolveEndpoint('cosmos-app-ph', MY, ''), PH);
	assert.equal(resolveEndpoint('', MY, ''), MY);
	assert.throws(() => resolveEndpoint('https://evil.example.com', MY, ''), /documents\.azure\.com/);
	assert.throws(
		() => resolveEndpoint('cosmos-app-id', MY, `${MY}, ${PH}`),
		/Allowed Endpoints/,
	);
	assert.equal(
		resolveEndpoint(
			'cosmos-app-ph',
			MY,
			'cosmos-app-my, cosmos-app-ph',
		),
		PH,
	);
	assert.throws(() => resolveEndpoint('', '', ''), /No endpoint/);
	// credential default must also respect its own allowlist
	assert.throws(() => resolveEndpoint('', MY, PH), /Allowed Endpoints/);
});

test('workload identity without a token file fails with a clear message', () => {
	const prev = process.env.AZURE_FEDERATED_TOKEN_FILE;
	delete process.env.AZURE_FEDERATED_TOKEN_FILE;
	assert.throws(
		() =>
			getAppTokenCredential({
				identityType: 'workloadIdentity',
				tenantId: 't',
				clientId: 'c-unique-1',
			}),
		/AZURE_FEDERATED_TOKEN_FILE/,
	);
	if (prev) process.env.AZURE_FEDERATED_TOKEN_FILE = prev;
});

test('app identity credentials are cached per identity', () => {
	const a = getAppTokenCredential({
		identityType: 'clientSecret',
		tenantId: 't',
		clientId: 'c',
		clientSecret: 's',
	});
	const b = getAppTokenCredential({
		identityType: 'clientSecret',
		tenantId: 't',
		clientId: 'c',
		clientSecret: 's',
	});
	const c = getAppTokenCredential({
		identityType: 'clientSecret',
		tenantId: 't',
		clientId: 'c2',
		clientSecret: 's',
	});
	assert.equal(a, b);
	assert.notEqual(a, c);
});

test('factory reuses one client per endpoint', async () => {
	const ctx = {
		getCredentials: async () => ({ endpoint: MY, key: Buffer.from('k').toString('base64') }),
	};
	const f = await CosmosClientFactory.create(ctx, 'masterKey');
	const a = await f.get('');
	const b = await f.get('cosmos-app-my');
	const c = await f.get('cosmos-app-ph');
	assert.equal(a.client, b.client);
	assert.notEqual(a.client, c.client);
	assert.equal(c.endpoint, PH);
});

// ---- execute() with a fake Cosmos backend ------------------------------------------

function fakeBackend() {
	const calls = [];
	const orig = cosmos.CosmosClient.prototype.database;
	cosmos.CosmosClient.prototype.database = function (db) {
		const endpoint = this.clientContext?.cosmosClientOptions?.endpoint;
		return {
			container: (name) => ({
				read: async () => ({ resource: { partitionKey: { paths: ['/uid'] } } }),
				items: {
					query: (spec) => ({
						fetchAll: async () => {
							calls.push({ op: 'query', endpoint, db, name, spec });
							return { resources: [{ id: 'DOC1' }] };
						},
					}),
				},
				item: (id, pk) => ({
					read: async () => {
						calls.push({ op: 'read', endpoint, db, name, id, pk });
						return id === 'missing'
							? { resource: undefined, statusCode: 404 }
							: { resource: { id, uid: pk, _etag: '"e1"' }, statusCode: 200 };
					},
					replace: async (doc, opts) => {
						calls.push({ op: 'replace', endpoint, db, name, id, pk, opts });
						if (opts?.accessCondition?.condition === '"stale"') {
							const e = new Error('Precondition Failed');
							e.code = 412;
							throw e;
						}
						return { resource: { ...doc, _etag: '"e2"' }, statusCode: 200 };
					},
				}),
			}),
		};
	};
	return {
		calls,
		restore: () => {
			cosmos.CosmosClient.prototype.database = orig;
		},
	};
}

function ctxFor(itemsParams, { auth = 'masterKey', continueOnFail = false } = {}) {
	return {
		getInputData: () => itemsParams.map(() => ({ json: {} })),
		getNodeParameter: (name, i, fallback) => {
			if (name === 'authenticationType') return auth;
			const v = itemsParams[i][name];
			return v === undefined ? fallback : v;
		},
		getCredentials: async () => ({ endpoint: MY, key: Buffer.from('k').toString('base64') }),
		getNode: () => ({ name: 'Cosmos', type: 'azureCosmosPlus', typeVersion: 1, parameters: {} }),
		continueOnFail: () => continueOnFail,
		logger: { info() {}, warn() {}, debug() {} },
	};
}

const base = { databaseName: 'appdb', containerName: 'PaymentsToBank' };

test('select passes query parameters and routes each item to its own account', async () => {
	const fb = fakeBackend();
	try {
		const node = new AzureCosmosPlus();
		const out = await node.execute.call(
			ctxFor([
				{
					...base,
					operation: 'select',
					sqlQuery: 'SELECT * FROM c WHERE c.id = @id',
					queryParameters: '[{"name":"@id","value":"DOC1"}]',
				},
				{
					...base,
					operation: 'select',
					endpointOverride: 'cosmos-app-ph',
					sqlQuery: 'SELECT * FROM c WHERE c.id = @id',
					queryParameters: [{ name: '@id', value: 'DOC2' }],
				},
			]),
		);
		assert.equal(out[0].length, 2);
		assert.deepEqual(
			fb.calls.map((c) => [c.endpoint, c.spec.parameters[0].value]),
			[
				[MY, 'DOC1'],
				[PH, 'DOC2'],
			],
		);
	} finally {
		fb.restore();
	}
});

test('read returns the document; missing doc errors or returns empty', async () => {
	const fb = fakeBackend();
	try {
		const node = new AzureCosmosPlus();
		const out = await node.execute.call(
			ctxFor([{ ...base, operation: 'read', itemId: 'DOC1', itemPartitionKey: 'DOC1' }]),
		);
		assert.equal(out[0][0].json._etag, '"e1"');
		const empty = await node.execute.call(
			ctxFor([
				{
					...base,
					operation: 'read',
					itemId: 'missing',
					itemPartitionKey: 'x',
					notFoundBehavior: 'empty',
				},
			]),
		);
		assert.deepEqual(empty[0][0].json, {});
		await assert.rejects(
			node.execute.call(
				ctxFor([{ ...base, operation: 'read', itemId: 'missing', itemPartitionKey: 'x' }]),
			),
			/not found/,
		);
	} finally {
		fb.restore();
	}
});

test('replace sends If-Match from the document, derives the partition key, and surfaces 412', async () => {
	const fb = fakeBackend();
	try {
		const node = new AzureCosmosPlus();
		const doc = { id: 'TXN1', uid: 'USER1', status: 'rejected', _etag: '"e1"' };
		const out = await node.execute.call(
			ctxFor([
				{
					...base,
					containerName: 'Transactions',
					operation: 'replace',
					document: JSON.stringify(doc),
				},
			]),
		);
		const call = fb.calls.find((c) => c.op === 'replace');
		assert.equal(call.pk, 'USER1');
		assert.deepEqual(call.opts, { accessCondition: { type: 'IfMatch', condition: '"e1"' } });
		assert.equal(out[0][0].json._etag, '"e2"');

		await assert.rejects(
			node.execute.call(
				ctxFor([
					{
						...base,
						operation: 'replace',
						itemPartitionKey: 'USER1',
						ifMatchEtag: '"stale"',
						document: doc,
					},
				]),
			),
			/412/,
		);
		await assert.rejects(
			node.execute.call(
				ctxFor([
					{
						...base,
						operation: 'replace',
						itemPartitionKey: 'USER1',
						document: { id: 'TXN1', uid: 'USER1' },
					},
				]),
			),
			/No ETag/,
		);
	} finally {
		fb.restore();
	}
});

test('an endpoint override outside *.documents.azure.com is rejected per item', async () => {
	const node = new AzureCosmosPlus();
	await assert.rejects(
		node.execute.call(
			ctxFor([
				{
					...base,
					operation: 'select',
					sqlQuery: 'SELECT 1',
					endpointOverride: 'https://attacker.example.com',
				},
			]),
		),
		/documents\.azure\.com/,
	);
});
