# vcmp-js

Implements a VCMP client and server in TypeScript.
VCMP is a very simple, lightweight and generic messaging protocol over WebSockets.

## Usage

### Using the client

Install the package:

```shell
npm install @variocube/vcmp
```

Simple example:

```typescript
import {VcmpClient} from "@variocube/vcmp";

const client = new VcmpClient("ws://localhost:12345/", {autoStart: true});
client.on("hello", ({from}) => console.log(`Received a hello from ${from}.`));
client.send({"@type": "hello", from: "client"});
```

On Node, where there is no global `WebSocket`, pass an implementation via `customWebSocket`:

```typescript
import WebSocket from "ws";

const client = new VcmpClient("ws://localhost:12345/", {autoStart: true, customWebSocket: WebSocket});
```

The option is typed structurally (`VcmpWebSocketConstructor`), so the package's declarations do not
reference `ws` and a browser-only project neither needs `@types/ws` nor inherits Node's globals
through it.

### Using the server

Install the package:

```shell
npm install @variocube/vcmp-server
```

Simple example:

```typescript
import {VcmpServer} from "@variocube/vcmp-server";

const server = new VcmpServer({port: 12345});
server.on("hello", ({from}) => console.log(`Received a hello from ${from}.`));
server.onSessionConnected = (session) => {
	session.send({"@type": "hello", from: "server"})
		.catch(error => console.warn("Could not deliver hello", error));
};
```

Note the `.catch`: `send` returns a promise that can reject (see below). A fire-and-forget call
site must attach a rejection handler, otherwise a session closing at the wrong moment surfaces as
an unhandled promise rejection — which terminates a Node process by default.

## Send semantics

The promise returned from `send` settles when the peer acknowledges the message — after the peer's
message handler has completed:

- It **resolves** with the handler's result when the peer sends an ACK.
- It **rejects** with a `VcmpError` when:
  - the peer's handler fails (NAK, carrying the peer's `ProblemDetail`),
  - the underlying WebSocket is not open at the time of sending (status 503, "Session not open"), or
  - the session closes before the ACK arrives (status 503, "Session closed").

There is deliberately **no library-level acknowledgement timeout**: different operations have
vastly different legitimate durations (the ACK is only sent after the peer's handler completes),
so bounding the wait is the caller's decision — race an individual send against your own timer
where a bound is needed. The same policy applies in the Java implementation (vcmp-spring), where
`VcmpCallback.await(...)` serves that purpose.

A send on an open session whose peer never acknowledges stays pending until the session closes.
A dead connection is detected by the heartbeat and abandoned (see below) — provided the heartbeat
is running: `VcmpServer` initiates it automatically on every connection (`heartbeatInterval`,
default 20 s), and both sides then watchdog it. `VcmpClient` additionally expects the server to
initiate a heartbeat within `initialHeartbeatTimeout` (default 60 s, a value of 0 or below disables
it) of the connection opening and abandons the session otherwise — so a half-open connection
through which no heartbeat ever arrives cannot leave sends pending indefinitely. A standalone
`VcmpSession` only has this protection once `initiateHeartbeat` is called (or the peer initiates
and `expectHeartbeat` bounds the wait for it).

Abandoning a dead connection does not wait for the WebSocket close handshake, which a dead peer
never answers — on a connection that silently drops packets, the socket's close event would only
arrive once TCP gives up (up to around 15 minutes for a browser WebSocket) or, with `ws`, once its
close timeout expires (30 s by default). Instead, the socket is terminated where the
implementation supports it (`ws`) and closed otherwise, and the session closes immediately: pending
sends are rejected, `onClose` is raised once, and `VcmpClient` schedules its reconnect (after
`reconnectTimeout`) without waiting for the socket. The socket's late close event is ignored.

Note that a `VcmpError` rejection no longer implies the peer answered: 503 describes a local
transport condition, while a NAK carries the peer's own status. A rejection other than a NAK also
does not imply the peer ignored the message: an ACK lost to a connection loss still means the
handler ran. Use an idempotent retry if the operation must be applied exactly once.

**Upgrade note (breaking):** sends that previously could stay pending forever now reject. Audit
fire-and-forget `send(...)` call sites and attach `.catch(...)`, otherwise these rejections are
unhandled promise rejections.

## Session authentication (`AUT`)

Browsers can't set headers on a WebSocket handshake, so a credential would otherwise have to go into the
URL, where it ends up in access logs, proxies and CDNs. VCMP authenticates a session in-band instead,
with an `AUT` frame (specified in [vcmp-spring#34](https://github.com/variocube/vcmp-spring/issues/34) and
implemented wire-compatibly by vcmp-spring, vcmp-js and vcmp-rs).

### Protocol

| Frame | Layout                           | Meaning                                                                                                     |
| ----- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AUT` | `AUT` + 12-char id + JSON object | Client → server: authenticate this session. The endpoint defines the object's shape, e.g. `{"token": "…"}`. |

- The server answers with `ACK` + id, or `NAK` + id with a problem detail: `400` malformed (or an `AUT`
  on an endpoint without authentication), `401` invalid credential, `403` valid but not allowed
  (incl. a different principal on re-authentication), `500` the authenticator failed unexpectedly.
- The `ACK` payload is a JSON object or empty. Its member `expiresIn` (integer, milliseconds from sending
  the `ACK`) is reserved by the protocol: the session's authentication expires then (absent: never). Any
  other member is the endpoint's own and is passed to the client application.
- Until a session is authenticated, the server accepts only `HBT` and `AUT`. Every session a server closes
  for an authentication reason is closed with code **1008** (policy violation); a client closes with
  **4008** instead (a browser's WebSocket only lets a client close with 1000 or 3000–4999), which peers
  treat like 1008. Both give an informative reason:
  `authentication required` (a frame other than `HBT`/`AUT` first), `authentication timeout` (no
  successful `AUT` within the timeout, default 10 s from connect until the first `ACK` is sent, so it
  also covers a hanging authenticator), `authentication failed` (`NAK` to the first `AUT`),
  `authentication expired`, `principal changed`, `concurrent authentication` (a second `AUT` while one is
  pending).
- An `AUT` on an authenticated session is a **re-authentication**; messages keep flowing meanwhile. Same
  principal → `ACK` with the new `expiresIn` (the expiry is replaced, or removed). Another principal →
  `NAK` 403 and the session closes: a session never changes identity. Any other failure (`NAK` 400, 401,
  403 or 500) keeps the session open until its current expiry.
- A session is authenticated only once its `ACK` is out: a failure after the authenticator accepted (no
  principal, the principal comparison throws, the `ACK` payload can't be serialized) is answered with
  `NAK` 500 and fails closed like an authenticator failure.
- An `AUT` is not a message: it is never dispatched to message handlers, and its payload (the
  credential) is never written to debug output (`AUT<id>[redacted]`), nor are errors that would quote it.
  Exceptions of the application's authenticator are logged by type and message: keep credentials out of
  them. `wss://` is still required for anything secret.

### Client

```typescript
const client = new VcmpClient("wss://example.com/vcmp", {
	autoStart: true,
	authenticate: async () => ({token: await fetchToken()}),
});
client.onOpen = () => console.log("Authenticated, ready to send");
client.onAuthenticated = ack => console.log("Authenticated as", ack.user, "expires in", ack.expiresIn);
client.onAuthenticationError = error => console.warn("Authentication failed", error.status, error.title);
```

- `authenticate` is called on **every** (re)connect, so it can return a fresh credential. The client sends
  `AUT` first and holds back every message sent meanwhile until the `ACK`. `onOpen` is raised, and
  `connected` becomes `true`, only after the `ACK`; `client.authentication` holds its payload.
- A `NAK`, no answer within `authenticationTimeout` (default 10 s; e.g. an older server that doesn't know
  `AUT`) or a failing credential provider is reported to `onAuthenticationError` (the `NAK`'s problem
  detail; 504 for the timeout; 500 for the provider). The client then closes the session (4008) and
  reconnects after `reconnectTimeout` with a fresh credential. Held messages are rejected (503).
- When the `ACK` carries `expiresIn`, the client re-authenticates `refreshLeadTime` before the expiry
  (default `min(60 s, 20 % of expiresIn)`; a number or a function of `expiresIn`), counted from receiving
  the `ACK`, so clock skew between client and server doesn't matter. The lead time is at most half of
  `expiresIn`, and a refresh is never sent sooner than 1 s after the `ACK`, so no setting can cause a
  refresh loop. A refresh answered with a `NAK` (or
  whose credential provider fails) is reported and retried every `refreshRetryDelay` (default 5 s) until
  the expiry, after which the server closes the session and the client reconnects as usual. A refresh
  that gets no answer within `authenticationTimeout` is reported (504) and not retried on that session
  (the server may still be processing it, and a second `AUT` would close the session as concurrent): the
  client closes the session (4008) and reconnects with a fresh credential.

Without `authenticate`, the client behaves exactly as before.

### Server

```typescript
const server = new VcmpServer<{ userId: string }>({
	port: 12345,
	authentication: {
		// return the principal (optionally with an expiry and ACK members), or throw to reject
		authenticate: async ({token}, session) => {
			const claims = await verify(token); // throws VcmpError {status: 401} when invalid
			return {principal: {userId: claims.sub}, expiresAt: new Date(claims.exp * 1000)};
		},
		timeout: 10000, // optional
	},
});
server.onSessionConnected = session => console.log("Connected:", session.principal?.userId);
```

- The authenticator gets the credential and the session, and must return a principal (`undefined` or
  `null` is answered with `NAK` 500). A thrown `VcmpError` (or problem detail) with
  status 400, 401 or 403 is answered with that status; anything else is an unexpected failure, answered
  with `NAK` 500 without its message. Either way, a failed first `AUT` closes the session, a failed
  re-authentication keeps it until its current expiry.
  Its `ack` members go into the `ACK` payload (`expiresIn` is set by the library from `expiresAt`).
- `onSessionConnected` is raised only once the session authenticated, `onSessionDisconnected` only for
  sessions that were connected; `sessions` and `broadcast` contain authenticated sessions only, and a
  session refuses `send` (503) until it is authenticated. `session.principal` holds the principal.
- Re-authentications must carry the same principal, compared with `principalEquals` (default: deep
  equality).

Without `authentication`, the server behaves exactly as before, except that it answers an `AUT` with
`NAK` 400.

#### Transition: old clients with a handshake credential

An endpoint that switches to `AUT` may still have clients that send their credential in the handshake
(query parameter, path, header). For the migration, add a handshake authenticator, which gets the
handshake request:

```typescript
authentication: {
	authenticate,
	authenticateHandshake: (request, session) => {
		const token = new URL(request.url!, "http://localhost").searchParams.get("token");
		if (token == null) {
			return undefined; // no handshake credential: the session must send AUT
		}
		return verifyLegacyToken(token); // throws when invalid: the session is closed (1008)
	},
},
```

- A valid handshake credential authenticates the session at connect, as before (no `AUT` expected); an
  invalid one closes it (1008), without a fallback to `AUT`; none means the session waits for `AUT`.
- An `AUT` on a session authenticated by its handshake is a re-authentication (same principal required).
- The handshake authenticator may be asynchronous; frames arriving meanwhile are held back.
- `server.authenticationCounts` (`{handshake, aut}`) counts the sessions authenticated each way, and every
  authentication is logged (`debug.info`), so the endpoint knows when the last old client is gone and the
  handshake authenticator can be removed.
