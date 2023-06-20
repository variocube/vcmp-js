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