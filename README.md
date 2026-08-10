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
  - the underlying WebSocket is not open at the time of sending (status 503, "Session not open"),
  - the session closes before the ACK arrives (status 503, "Session closed"), or
  - the optional ack timeout elapses first (status 504, "Acknowledgement timeout").

The ack timeout is **disabled by default**: how long to wait for a live-but-unresponsive peer is
the caller's decision. Opt in via the `ackTimeout` option (milliseconds) of `VcmpClient` and
`VcmpServer` to bound every send of that instance, or race an individual send against your own
timer. With the timeout disabled, a send on a healthy, open session whose peer never acknowledges
stays pending until the session closes (a dead connection is detected by the heartbeat and closed).

Note that a `VcmpError` rejection no longer implies the peer answered: 503/504 describe local
transport conditions, while a NAK carries the peer's own status. A rejection other than a NAK also
does not imply the peer ignored the message: an ACK lost to a connection loss still means the
handler ran. Use an idempotent retry if the operation must be applied exactly once.

**Upgrade note (breaking):** sends that previously could stay pending forever now reject. Audit
fire-and-forget `send(...)` call sites and attach `.catch(...)`, otherwise these rejections are
unhandled promise rejections.
