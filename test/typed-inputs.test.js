'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const Module = require('node:module');
const runtimeUtil = require('@node-red/util').util;
const { completion } = require('./harness');
const root = path.resolve(__dirname, '..');

// Phase 2.9: the typed fields of the OpenAI V1 node and its connection. T1 pins what the editor
// offers, T2 checks that the runtime accepts exactly the offered types, T3 evaluates every offered
// type, T4 rejects any other type before anything is evaluated or requested (inactive fields
// excepted), T5 pins the defaults of flows saved without the fields, and T6 pins the request
// payloads of the new literals (P2: env JSON for Extra Parameters, P6: a JSON input).

const NODE_FIELDS = {
    model: {
        types: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
        default: 'str',
        value: '',
        type: 'str',
    },
    instructions: {
        types: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
        default: 'str',
        value: '',
        type: 'str',
    },
    input: {
        types: ['msg', 'flow', 'global', 'str', 'json', 'jsonata', 'env'],
        default: 'msg',
        value: 'payload',
        type: 'msg',
    },
    extraParameters: {
        types: ['msg', 'flow', 'global', 'json', 'jsonata', 'env'],
        default: 'json',
        value: '{}',
        type: 'json',
    },
    output: { types: ['msg', 'flow', 'global'], default: 'msg', value: 'payload', type: 'msg' },
};
const CONFIG_FIELDS = {
    baseUrl: {
        types: ['str', 'env'],
        default: 'str',
        value: 'https://api.openai.com/v1',
        type: 'str',
    },
};
const LABELS = {
    model: 'Model',
    instructions: 'Instructions',
    input: 'Input',
    extraParameters: 'Extra Parameters',
};
// Every type a hand-edited or imported flow could carry: Node-RED's own plus an unknown name.
const CANDIDATES = [
    'str',
    'num',
    'bool',
    'json',
    'bin',
    're',
    'date',
    'jsonata',
    'env',
    'msg',
    'flow',
    'global',
    'node',
    'cred',
    'foo',
];

// Runs an editor's registration script and its oneditprepare against a recording jQuery stub.
function loadEditor(file, nodeType) {
    const html = fs.readFileSync(path.join(root, 'src', file), 'utf8');
    const defs = {};
    const inputs = {};
    const element = (selector) =>
        new Proxy(function () {}, {
            get(target, prop) {
                if (prop === 'selector') return selector;
                if (prop === 'length') return 0;
                if (prop === 'typedInput') {
                    return (options) => {
                        inputs[selector.replace(/^#node-(config-)?input-/, '')] = {
                            // Copied into this realm: the editor script runs in its own.
                            types: Array.from(options.types),
                            default: options.default,
                            typeField: options.typeField && options.typeField.selector,
                        };
                        return element(selector);
                    };
                }
                if (prop === 'val') return () => '';
                if (prop === 'prop' || prop === 'is') return () => false;
                return () => element(selector);
            },
            apply: () => element(selector),
        });
    const RED = {
        nodes: { registerType: (name, def) => (defs[name] = def) },
        validators: { typedInput: () => () => true },
        _: (key) => key,
    };
    const [, source] = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    vm.runInNewContext(source, { RED, $: (selector) => element(String(selector)) });
    const definition = defs[nodeType];
    const self = Object.fromEntries(
        Object.entries(definition.defaults).map(([key, spec]) => [key, spec.value]),
    );
    definition.oneditprepare.call(self);
    return { definition, inputs };
}

// The product never reaches the global fetch: its modules are compiled with `fetch` bound to this
// fence, which stays bound for good. The fence serves only the run that owns the call (an
// AsyncLocalStorage owner set around each input) while that run is active. Any other call, before
// a run, after its cleanup or from a stale continuation of an earlier run, is refused and
// recorded; it is never passed on to another run or to a real transport.
const owner = new AsyncLocalStorage();
const strays = [];
async function fenceFetch(url, init) {
    const current = owner.getStore();
    if (!current || !current.active) {
        strays.push(String(url));
        throw new Error('fetch called outside an active test run');
    }
    current.requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(completion()), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-29' },
    });
}
after(() => {
    assert.deepEqual(strays, []);
});

// Loads a product module with `fetch` bound to the fence and the given modules in place of its
// own requires.
function loadWithFence(file, replaced = {}) {
    const filename = path.join(root, 'src', file);
    const load = Module.createRequire(filename);
    const module = { exports: {} };
    const body = vm.compileFunction(
        fs.readFileSync(filename, 'utf8'),
        ['exports', 'require', 'module', '__filename', '__dirname', 'fetch'],
        { filename },
    );
    const requireReplaced = (id) => (id in replaced ? replaced[id] : load(id));
    body(module.exports, requireReplaced, module, filename, path.dirname(filename), fenceFetch);
    return module.exports;
}

const chatRequest = loadWithFence('lib/chat-request.js');
const configModule = loadWithFence('openai-v1-compatible-config.js', {
    './lib/chat-request': chatRequest,
});
const nodeModule = loadWithFence('openai-v1-compatible.js', { './lib/chat-request': chatRequest });
const { TYPES } = nodeModule;

// Loads both nodes with real Node-RED util (counting evaluations), a context with readable named
// stores, and a connection whose lookups are counted.
function loadNodes() {
    const constructors = {};
    const nodes = new Map();
    const stores = { default: {}, file: {} };
    const evaluations = [];
    const connections = [];
    const util = {
        ...runtimeUtil,
        evaluateNodeProperty(value, type, ...rest) {
            evaluations.push(type);
            return runtimeUtil.evaluateNodeProperty(value, type, ...rest);
        },
    };
    const RED = {
        util,
        nodes: {
            registerType: (type, ctor) => (constructors[type] = ctor),
            getNode: (id) => nodes.get(id),
            createNode(node, config) {
                const events = new EventEmitter();
                node.id = config.id;
                node.on = events.on.bind(events);
                node.listeners = events.listeners.bind(events);
                node.emit = events.emit.bind(events);
                node.status = () => {};
                node.log = () => {};
                node.warn = () => {};
                node.error = () => {};
                node.credentials = config._credentials || {};
                // As in Node-RED's context, a `#:(store)::` prefix on the key selects the store.
                const locate = (key, store) => {
                    const parsed = runtimeUtil.parseContextStore(key);
                    return [stores[store || parsed.store || 'default'], parsed.key];
                };
                const scope = {
                    get(key, store, cb) {
                        if (typeof store === 'function') [cb, store] = [store, undefined];
                        const [data, name] = locate(key, store);
                        return cb ? cb(null, data[name]) : data[name];
                    },
                    set(key, value, store, cb) {
                        if (typeof store === 'function') [cb, store] = [store, undefined];
                        const [data, name] = locate(key, store);
                        data[name] = value;
                        if (cb) cb();
                    },
                };
                node.context = () => ({ flow: scope, global: scope });
                node._flow = { getSetting: (key) => process.env[key] };
            },
        },
    };
    configModule(RED);
    nodeModule(RED);
    const create = (type, config) => {
        const node = new constructors[type](config);
        nodes.set(config.id, node);
        return node;
    };
    return { create, stores, evaluations, connections };
}

async function run(config = {}, msg = { payload: 'Hello' }, options = {}) {
    const h = loadNodes();
    const connection = h.create('openai-v1-compatible-config', {
        id: 'connection',
        baseUrl: 'https://llm.example.test/v1',
        baseUrlType: 'str',
        maxRetries: 0,
        timeoutMs: 120000,
        ...options.connection,
        _credentials: { apiKey: 'test-api-key' },
    });
    const getConnection = connection.getConnection;
    connection.getConnection = () => {
        h.connections.push('getConnection');
        return getConnection();
    };
    const node = h.create('openai-v1-compatible', {
        id: 'ai',
        config: 'connection',
        model: 'test-model',
        ...config,
    });
    Object.assign(h.stores.default, options.preset);
    const sent = [];
    const completions = [];
    const current = { active: true, requests: [] };
    try {
        await owner.run(current, () =>
            node.listeners('input')[0](
                msg,
                (m) => sent.push(m),
                (err) => completions.push(err),
            ),
        );
    } finally {
        current.active = false;
        node.emit('close');
    }
    return {
        sent,
        error: completions[0],
        requests: current.requests,
        evaluations: h.evaluations,
        connections: h.connections,
        stores: h.stores,
    };
}

// Sets environment variables for one test and removes them afterwards.
async function withEnv(values, fn) {
    Object.assign(process.env, values);
    try {
        return await fn();
    } finally {
        for (const key of Object.keys(values)) delete process.env[key];
    }
}

const CHAT_URL = 'https://llm.example.test/v1/chat/completions';

test('the fetch fence refuses a request outside any run, and the global fetch is untouched', async () => {
    const before = globalThis.fetch;
    await assert.rejects(fenceFetch(CHAT_URL, { body: '{}' }), /outside an active test run/);
    assert.deepEqual(strays.splice(0), [CHAT_URL]);
    assert.equal(globalThis.fetch, before);
});

test('a late call of a finished run is refused, not served by the run in progress', async () => {
    const earlier = { active: true, requests: [] };
    let late;
    owner.run(earlier, () => {
        setTimeout(() => {
            late = fenceFetch(CHAT_URL, { body: '{}' }).catch((err) => err);
        }, 20);
    });
    earlier.active = false;
    const current = { active: true, requests: [] };
    await owner.run(current, () => new Promise((resolve) => setTimeout(resolve, 60)));
    assert.match((await late).message, /outside an active test run/);
    assert.deepEqual(current.requests, []);
    assert.deepEqual(earlier.requests, []);
    assert.deepEqual(strays.splice(0), [CHAT_URL]);
});

// T1

const editors = [
    [
        'openai-v1-compatible',
        loadEditor('openai-v1-compatible.html', 'openai-v1-compatible'),
        NODE_FIELDS,
        'node-input',
    ],
    [
        'openai-v1-compatible-config',
        loadEditor('openai-v1-compatible-config.html', 'openai-v1-compatible-config'),
        CONFIG_FIELDS,
        'node-config-input',
    ],
];

for (const [nodeType, { definition, inputs }, fields, prefix] of editors) {
    test(`T1 ${nodeType}: the editor creates exactly the expected typed inputs`, () => {
        assert.deepEqual(Object.keys(inputs).sort(), Object.keys(fields).sort());
    });

    for (const [field, expected] of Object.entries(fields)) {
        test(`T1 ${nodeType} ${field}: offered types, default type, type field and saved defaults`, () => {
            assert.deepEqual(inputs[field].types, expected.types);
            assert.equal(inputs[field].default, expected.default);
            assert.equal(inputs[field].typeField, `#${prefix}-${field}Type`);
            assert.equal(definition.defaults[field].value, expected.value);
            assert.equal(definition.defaults[`${field}Type`].value, expected.type);
        });
    }
}

// T2

for (const [field, label] of Object.entries(LABELS)) {
    test(`T2 ${field}: the exported list equals the offered types`, () => {
        assert.deepEqual([...TYPES[field]].sort(), [...NODE_FIELDS[field].types].sort());
    });

    test(`T2 ${field}: the runtime accepts exactly the offered types`, async () => {
        const accepted = [];
        for (const type of CANDIDATES) {
            const result = await run({ [field]: 'value', [`${field}Type`]: type });
            const rejected =
                result.error && result.error.message === `${label} type '${type}' is not supported`;
            if (!rejected) accepted.push(type);
        }
        assert.deepEqual(accepted.sort(), [...NODE_FIELDS[field].types].sort());
    });
}

test('T2 output: the runtime accepts exactly the offered types (its existing check)', async () => {
    const accepted = [];
    for (const type of CANDIDATES) {
        const result = await run({ output: 'out', outputType: type });
        const rejected =
            result.error && result.error.message === 'Output must target msg, flow, or global';
        if (!rejected) accepted.push(type);
    }
    assert.deepEqual(accepted.sort(), [...NODE_FIELDS.output.types].sort());
});

test('T2 baseUrl: the connection accepts exactly the offered types (its existing check)', async () => {
    const accepted = [];
    for (const type of CANDIDATES) {
        const result = await run({}, undefined, { connection: { baseUrlType: type } });
        const rejected =
            result.error &&
            result.error.message === 'Base URL must use string or environment input';
        if (!rejected) accepted.push(type);
    }
    assert.deepEqual(accepted.sort(), [...CONFIG_FIELDS.baseUrl.types].sort());
});

// T3

const valueCases = (value, envName, text) => ({
    msg: [{ value: 'v' }, { payload: 'Hello', v: value }],
    flow: [{ value: 'v' }, undefined, { v: value }],
    global: [{ value: 'v' }, undefined, { v: value }],
    str: [{ value: text }],
    jsonata: [{ value: JSON.stringify(text) }],
    env: [{ value: envName }],
});

const t3 = {
    model: {
        cases: valueCases('model-29', 'OPENAI_29_VALUE', 'model-29'),
        env: 'model-29',
        check: (body) => assert.equal(body.model, 'model-29'),
    },
    instructions: {
        cases: valueCases('Be brief', 'OPENAI_29_VALUE', 'Be brief'),
        env: 'Be brief',
        check: (body) =>
            assert.deepEqual(body.messages[0], { role: 'system', content: 'Be brief' }),
    },
    input: {
        cases: {
            ...valueCases('Hi there', 'OPENAI_29_VALUE', 'Hi there'),
            json: [{ value: '[{"role":"user","content":"Hi there"}]' }],
        },
        env: 'Hi there',
        check: (body) => assert.deepEqual(body.messages, [{ role: 'user', content: 'Hi there' }]),
    },
    extraParameters: {
        cases: {
            msg: [{ value: 'v' }, { payload: 'Hello', v: { top_p: 0.5 } }],
            flow: [{ value: 'v' }, undefined, { v: { top_p: 0.5 } }],
            global: [{ value: 'v' }, undefined, { v: { top_p: 0.5 } }],
            json: [{ value: '{"top_p":0.5}' }],
            jsonata: [{ value: '{"top_p": 0.5}' }],
            env: [{ value: 'OPENAI_29_VALUE' }],
        },
        env: '{"top_p":0.5}',
        check: (body) => assert.equal(body.top_p, 0.5),
    },
};

for (const [field, { cases, env, check }] of Object.entries(t3)) {
    test(`T3 ${field}: every offered type has a case`, () => {
        assert.deepEqual(Object.keys(cases).sort(), [...NODE_FIELDS[field].types].sort());
    });

    for (const [type, [{ value }, msg, preset]] of Object.entries(cases)) {
        test(`T3 ${field} of type ${type} reaches the request`, async () => {
            const result = await withEnv({ OPENAI_29_VALUE: env }, () =>
                run({ [field]: value, [`${field}Type`]: type }, msg, { preset }),
            );
            assert.equal(result.error, undefined);
            assert.equal(result.requests.length, 1);
            check(result.requests[0].body);
        });
    }
}

for (const type of NODE_FIELDS.output.types) {
    test(`T3 output of type ${type} receives the text`, async () => {
        const result = await run({ output: 'out', outputType: type });
        assert.equal(result.error, undefined);
        const written = type === 'msg' ? result.sent[0].out : result.stores.default.out;
        assert.equal(written, 'Hello from model');
    });
}

test('T3 output to a named store writes that store only', async () => {
    const result = await run({ output: '#:(file)::out', outputType: 'flow' });
    assert.equal(result.stores.file.out, 'Hello from model');
    assert.equal(result.stores.default.out, undefined);
});

for (const [type, baseUrl, env] of [
    ['str', 'https://llm.example.test/v1'],
    ['env', 'OPENAI_29_BASE_URL', { OPENAI_29_BASE_URL: 'https://env.example.test/v1' }],
]) {
    test(`T3 baseUrl of type ${type} is where the request goes`, async () => {
        const result = await withEnv(env || {}, () =>
            run({}, undefined, { connection: { baseUrl, baseUrlType: type } }),
        );
        assert.equal(result.error, undefined);
        const host = type === 'env' ? 'env.example.test' : 'llm.example.test';
        assert.equal(result.requests[0].url, `https://${host}/v1/chat/completions`);
    });
}

// T4

for (const [field, label] of Object.entries(LABELS)) {
    for (const type of ['num', 'foo']) {
        test(`T4 ${field} of type ${type} fails before anything is evaluated or requested`, async () => {
            const result = await run({ [field]: 'value', [`${field}Type`]: type });
            assert.equal(result.error.code, 'INVALID_CONFIG');
            assert.equal(result.error.message, `${label} type '${type}' is not supported`);
            assert.deepEqual(result.requests, []);
            assert.deepEqual(result.evaluations, []);
            assert.deepEqual(result.connections, []);
        });
    }
}

for (const type of ['str', 'foo']) {
    test(`T4 output of type ${type} keeps its existing error, before anything starts`, async () => {
        const result = await run({ output: 'out', outputType: type });
        assert.equal(result.error.code, 'INVALID_CONFIG');
        assert.equal(result.error.message, 'Output must target msg, flow, or global');
        assert.deepEqual(result.requests, []);
        assert.deepEqual(result.evaluations, []);
        assert.deepEqual(result.connections, []);
    });
}

test('T4 baseUrl of an unoffered type keeps its existing error, and nothing is requested', async () => {
    const result = await run({}, undefined, { connection: { baseUrlType: 'foo' } });
    assert.equal(result.error.code, 'INVALID_CONFIG');
    assert.equal(result.error.message, 'Base URL must use string or environment input');
    assert.deepEqual(result.requests, []);
});

test('T4 blank instructions are not evaluated, so their type is not checked', async () => {
    const result = await run({ instructions: '', instructionsType: 'foo' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.requests[0].body.messages, [{ role: 'user', content: 'Hello' }]);
});

test('T4 blank extra parameters are not evaluated, so their type is not checked', async () => {
    const result = await run({ extraParameters: '', extraParametersType: 'foo' });
    assert.equal(result.error, undefined);
    assert.deepEqual(Object.keys(result.requests[0].body).sort(), ['messages', 'model', 'stream']);
});

// T5

test('T5 a flow saved without the typed fields sends msg.payload with no extras into msg.payload', async () => {
    const result = await run({ model: 'legacy-model' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.requests[0].body, {
        model: 'legacy-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
    });
    assert.equal(result.sent[0].payload, 'Hello from model');
});

test('T5 the output path is trimmed', async () => {
    const result = await run({ output: ' out ' });
    assert.equal(result.sent[0].out, 'Hello from model');
});

// T6

test('T6 P2: Extra Parameters from env must contain a JSON object', async () => {
    for (const [text, message] of [
        ['not json', 'Extra Parameters must resolve to a JSON object'],
        ['[1]', 'Extra Parameters must resolve to an object'],
    ]) {
        const result = await withEnv({ OPENAI_29_VALUE: text }, () =>
            run({ extraParameters: 'OPENAI_29_VALUE', extraParametersType: 'env' }),
        );
        assert.equal(result.error.code, 'INVALID_EXTRA_PARAMETERS');
        assert.equal(result.error.message, message);
        assert.deepEqual(result.requests, []);
    }
});

test('T6 P6: a JSON message history is forwarded as it is', async () => {
    const history = [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Again' },
    ];
    const result = await run({ input: JSON.stringify(history), inputType: 'json' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.requests[0].body.messages, history);
});

test('T6 P6: a JSON object becomes one user message with its JSON text', async () => {
    const result = await run({ input: '{"question":"why"}', inputType: 'json' });
    assert.deepEqual(result.requests[0].body.messages, [
        { role: 'user', content: '{"question":"why"}' },
    ]);
});

test('T6 P6: a JSON history keeps its existing validation', async () => {
    for (const [input, code, message] of [
        ['[]', 'INPUT_MISSING', 'Message history is empty'],
        [
            '[{"role":"robot","content":"x"}]',
            'INVALID_MESSAGES',
            'Input message 0 has an invalid role',
        ],
    ]) {
        const result = await run({ input, inputType: 'json' });
        assert.equal(result.error.code, code);
        assert.equal(result.error.message, message);
        assert.deepEqual(result.requests, []);
    }
});
