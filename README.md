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
	session.send({"@type": "hello", from: "server"});
};
```

## Send semantics

The promise returned from `send` settles when the peer acknowledges the message — after the peer's
message handler has completed:

- It **resolves** with the handler's result when the peer sends an ACK.
- It **rejects** with a `VcmpError` when:
  - the peer's handler fails (NAK, carrying the peer's `ProblemDetail`),
  - the underlying WebSocket is not open at the time of sending (status 503, "Session not open"),
  - the session closes before the ACK arrives (status 503, "Session closed"), or
  - the acknowledgement does not arrive within the ack timeout (status 504, "Acknowledgement timeout").

A `send` never stays pending indefinitely. The ack timeout defaults to 30 seconds and can be
configured — or disabled with a value of 0 — via the `ackTimeout` option of `VcmpClient` and
`VcmpServer`. Note that a rejection other than a NAK does not imply the peer ignored the message:
an ACK lost to a connection loss still means the handler ran. Use an idempotent retry if the
operation must be applied exactly once.
