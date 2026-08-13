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
A dead connection is detected by the heartbeat and closed — provided the heartbeat is running:
`VcmpServer` initiates it automatically on every connection (`heartbeatInterval`, default 20 s),
and both sides then watchdog it. `VcmpClient` additionally expects the server to initiate a
heartbeat within `initialHeartbeatTimeout` (default 60 s, a value of 0 or below disables it) of
the connection opening and closes the session otherwise — so a half-open connection through which
no heartbeat ever arrives cannot leave sends pending indefinitely. A standalone `VcmpSession` only
has this protection once `initiateHeartbeat` is called (or the peer initiates and `expectHeartbeat`
bounds the wait for it).

Note that a `VcmpError` rejection no longer implies the peer answered: 503 describes a local
transport condition, while a NAK carries the peer's own status. A rejection other than a NAK also
does not imply the peer ignored the message: an ACK lost to a connection loss still means the
handler ran. Use an idempotent retry if the operation must be applied exactly once.

**Upgrade note (breaking):** sends that previously could stay pending forever now reject. Audit
fire-and-forget `send(...)` call sites and attach `.catch(...)`, otherwise these rejections are
unhandled promise rejections.
