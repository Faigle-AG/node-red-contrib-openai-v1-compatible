# @faigle/node-red-contrib-openai-v1-compatible

Provider-agnostic Node-RED node for non-streaming OpenAI-style **V1 Chat Completions** endpoints.

The node deliberately implements a narrow contract:

```text
POST <base-url>/chat/completions
Authorization: Bearer <api-key>   # when configured
Content-Type: application/json
```

with a request body based on:

```json
{
    "model": "model-id",
    "messages": [{ "role": "user", "content": "prompt" }],
    "stream": false
}
```

It contains no provider presets and no provider-specific request rewriting.

## Features

- Shared connection config node for base URL, authentication, retries, timeout, and logging
- Stored API key, environment API key, or no authentication
- Configurable model using Node-RED typed properties
- Optional system instructions
- Text input or Chat Completions message arrays
- Optional `max_completion_tokens` and `temperature`
- Pass-through **Extra Parameters** object for optional or implementation-specific fields
- Generated-text or complete-response output
- Configurable `msg`, `flow`, or `global` output target
- Retry handling for network failures, timeouts, HTTP 408/409/429, and 5xx
- `Retry-After` and `retry-after-ms` support
- Request timeout and cancellation when the node closes
- Optional raw-response metadata
- Uses `@faigle/node-red-runtime-utils` for typed properties and status behavior

## Requirements

- Node.js 22+
- Node-RED 4+
- `@faigle/node-red-runtime-utils` `^0.6.7`
- An endpoint implementing a sufficiently compatible `POST /chat/completions` API

## Installation

From a package tarball:

```bash
cd ~/.node-red
npm install /path/to/package.tgz
```

Restart Node-RED after installation.

## Connection config node

The **OpenAI V1 Compatible Config** node owns endpoint and runtime connection settings. Reuse one config node across multiple processing nodes that share the same endpoint/authentication.

### Authentication

The shared configuration node supports:

- **Stored credential** — API key stored using Node-RED credentials
- **Environment variable** — API key resolved on every request; default variable is `OPENAI_API_KEY`
- **None** — no `Authorization` header

Enter only the API key value. Do not include `Bearer`.

### Base URL

The config node appends `/chat/completions` to the configured base URL. Base URL supports a literal string or an environment-variable reference.

Typical shape:

```text
https://api.example.com/v1
```

which becomes:

```text
https://api.example.com/v1/chat/completions
```

If the configured value already ends in `/chat/completions`, it is used as-is.

Both HTTP and HTTPS are accepted so local inference servers can be used. URLs containing embedded credentials, query strings, or fragments are rejected.

Examples of base-URL shapes:

```text
https://api.openai.com/v1
https://api.infomaniak.com/2/ai/<product_id>/openai/v1
http://localhost:8080/v1
```

These examples do not imply guaranteed compatibility with any particular provider or server version.

### Retry, timeout, and logging

The config node also owns **Max Retries**, **Timeout (ms)**, and request-metadata logging. This keeps transport behavior consistent for all processing nodes that share the connection.

## Typed Fields and Compatibility

The editor offers these types in this order. `baseUrl` belongs to the shared config node; the other fields belong to the processing node.

| Field             | Offered types                                            | New-node value / type               |
| ----------------- | -------------------------------------------------------- | ----------------------------------- |
| `baseUrl`         | `str`, `env`                                             | `https://api.openai.com/v1` / `str` |
| `model`           | `msg`, `flow`, `global`, `str`, `jsonata`, `env`         | `""` / `str`                        |
| `instructions`    | `msg`, `flow`, `global`, `str`, `jsonata`, `env`         | `""` / `str`                        |
| `input`           | `msg`, `flow`, `global`, `str`, `json`, `jsonata`, `env` | `payload` / `msg`                   |
| `extraParameters` | `msg`, `flow`, `global`, `json`, `jsonata`, `env`        | `{}` / `json`                       |
| `output`          | `msg`, `flow`, `global`                                  | `payload` / `msg`                   |

Input now offers JSON literals, and Extra Parameters now offers environment-variable values. Other changes to the lists are ordering only. Saved field names and constructor fallbacks are unchanged: omitted `input` becomes `payload`, omitted `extraParameters` becomes `{}`, and the output name is trimmed, with a blank/non-string name falling back to `payload`. Falsy type tags retain the type defaults shown above; truthy tags are validated without trimming. A falsy base URL retains its existing default URL.

After the existing processing-node configuration checks, unsupported active value tags fail with `INVALID_CONFIG` and `<Label> type '<type>' is not supported`, before resolving connection settings, typed evaluation or a request. Required model/input tags are checked even with blank expressions. Falsy optional instructions/extra-parameters expressions are not type-checked or passed to typed evaluation; whitespace-only strings remain active expressions. The existing `Output must target msg, flow, or global` and `Base URL must use string or environment input` checks remain unchanged.

Imported or hand-edited flows using unadvertised types may now be rejected. Malformed value/type pairs can now report the type error before a former value error, including `INVALID_CONFIG` instead of a later `INPUT_MISSING`. Successful request shapes, provider-specific validation, errors for supported-type values and output modes are unchanged.

For `flow` or `global`, named-store keys use Node-RED's `#:(store)::key` syntax where that store is configured. Store availability and persistence depend on the Node-RED context configuration.

## Processing node

### Model

Typed property resolved to a nonblank string, trimmed, and sent as the `model` field.

### Instructions

Optional typed value prepended to the request as:

```json
{ "role": "system", "content": "..." }
```

### Input

Defaults to `msg.payload`.

The input can be:

- text
- UTF-8 `Buffer`
- number or boolean, converted to text
- object, JSON-encoded into one `user` message
- Chat Completions message array

For example:

```js
msg.payload = [
    { role: 'system', content: 'Answer concisely.' },
    { role: 'user', content: 'Explain Node-RED.' },
];
return msg;
```

The editor's `json` type accepts a JSON literal using the same normalization as message-resolved data: an object becomes one JSON-text user message, while an array is validated as a Chat Completions history. It is not a provider-neutral history format. The node does not maintain conversation history between messages.

### Extra Parameters

An optional object merged into the outgoing request before the node applies its core fields.

Example:

```json
{
    "top_p": 0.9,
    "response_format": { "type": "json_object" },
    "seed": 123
}
```

This can also carry fields such as tools, tool choice, reasoning controls, `max_tokens`, or implementation-specific extensions.

The following fields are always controlled by the node and therefore override values in Extra Parameters:

- `model`
- `messages`
- `stream` (`false`)

When configured, the dedicated **Max Tokens** and **Temperature** fields also override corresponding Extra Parameters values.

The `env` type resolves an environment variable. Nonblank resolved text is JSON-parsed and must produce an object, not an array or `null`; invalid text/shape reports `INVALID_EXTRA_PARAMETERS` before a request. Missing or blank resolved parameters mean no extras. Extra Parameters are intentionally not provider-validated.

### Max Tokens

Optional positive integer sent as:

```json
{ "max_completion_tokens": 1024 }
```

Leave blank to omit it. If a target implementation uses another field such as `max_tokens`, leave this field blank and supply that value through Extra Parameters.

### Temperature

Optional number from `0` through `2`. Leave blank to omit it.

### Output

**Generated text** writes `choices[0].message.content` to the selected output target.

**Complete response object** writes the complete parsed JSON response.

Text mode returns an error when the first choice contains no text, for example a tool-call-only response. Use complete-response mode for such workflows.

## Metadata

The node adds:

```js
msg.openaiV1 = {
    id,
    requestId,
    model,
    created,
    finishReason,
    usage,
    outputText,
    statusCode,
    maxRetries,
    retries,
    timeoutMs,
};
```

When **Include raw response** is enabled:

```js
msg.openaiV1.response;
```

contains the complete parsed response.

`msg.openaiV1` is reserved for node metadata and is replaced on each successful request. Choose a separate output target such as `msg.answer`; do not use this namespace or a descendant. The current guard rejects paths beginning with `openaiV1`, but an explicit `msg.` prefix can bypass that check and the result can then be overwritten by metadata.

## Retry and timeout behavior

These settings are configured on the shared connection config node. Default retry count: `4`.

Retryable conditions:

- network failures
- timeouts
- HTTP 408
- HTTP 409
- HTTP 429
- HTTP 5xx

The node honors `Retry-After` and `retry-after-ms` where possible. Otherwise it uses bounded exponential backoff with jitter.

A timeout applies to each individual HTTP attempt, including reading the response body. Retry delays are additional.

Requests and retry delays are aborted when the node closes or is redeployed. Cancellation cannot guarantee that a remote provider has stopped generation or billing.

## Compatibility scope

The node implements only the OpenAI-style, non-streaming Chat Completions transport contract. It does **not** contain special handling for OpenAI, Infomaniak, Gemini, xAI, llama.cpp, Ollama, or any other implementation.

In particular, the node does not attempt to normalize:

- provider-specific authentication
- model capabilities
- optional parameter names or semantics
- unsupported roles
- tool definitions or tool execution
- structured-output differences
- multimodal differences
- provider-specific error objects beyond common message/code shapes
- streaming

If a server accepts the request shape and returns an OpenAI-style Chat Completion response, the node can use it. Otherwise the flow or server configuration must adapt accordingly.

## Portable text flow

```text
Inject (text in msg.payload) → OpenAI V1 Compatible → Debug (msg.answer)
Catch (scoped to the processing node) → error-handling flow
```

Select a connection config and a model supported by your endpoint. Set **Input** to `msg.payload`, **Output To** to `msg.answer`, and **Output Value** to generated text. Inject `Explain Node-RED in one sentence.` A normal result is a string at `msg.answer`; the original prompt remains at `msg.payload`, and metadata is added at `msg.openaiV1`. Model answers are not deterministic examples or trusted instructions.

Input sources support `msg`, `flow`, `global`, `str`, `jsonata`, and `env`; output targets support only `msg`, `flow`, and `global`. Writing to context still forwards the incoming message. Existing saved fields remain `input/inputType` and `output/outputType`.

This is the common subset with Ollama and Azure Foundry: **text input → configured text output**, not interchangeable native request/response objects. Ollama uses `/api/generate` and a plain prompt prefix; Foundry uses Responses `input` and `instructions`. OpenAI's message history, extra parameters, metadata and full-response mode remain specific to this node. There is no automatic tool execution or cross-provider history conversion.

Failures report through Node-RED Catch handling, not a success output. Inspect `msg.error.message` and `msg.error.code`; text mode can report `NO_TEXT_OUTPUT` for tool-only/refusal-only results. Validate generated structured data yourself and review sensitive error content before forwarding or logging it.

## Source layout

```text
src/openai-v1-compatible-config.js
src/openai-v1-compatible-config.html
src/openai-v1-compatible.js
src/openai-v1-compatible.html
src/lib/chat-request.js
```

The config node and processing node are registered as separate Node-RED modules.

## Development

Run static/style checks, then tests:

```fish
npm run lint
npm run format:check
npm test
```

`npm test` runs Mocha's `test/**/*_spec.js` suites followed by Node's built-in runner for `test/*.test.js`. A failure in either runner fails the command. Keep new tests with the appropriate runner/file suffix; do not load `node:test` cases only through Mocha.

Source checkouts declare sibling runtime-utils workspaces. Record the resolved dependency version/path when comparing runs; linked local tests do not verify a fresh standalone dependency installation.
