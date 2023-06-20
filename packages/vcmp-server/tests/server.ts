import {VcmpClient} from "@variocube/vcmp";
import {VcmpServer} from "../src";
import {expect} from "chai";
import NodeWebSocket from "ws";

describe("VcmpServer", () => {
    it("can instantiate and close", () => {
        const server = new VcmpServer({
            port: 12345,
        });
        server.stop();
    });

    it("can broadcast to clients", async () => {
        const server = new VcmpServer({
            port: 12345,
        });

        const client1 = await createConnectedClient("ws://localhost:12345");
        const client2 = await createConnectedClient("ws://localhost:12345");

        let messageCount = 0;
        client1.on("foo", () => { messageCount++ });
        client2.on("foo", () => { messageCount++ });

        server.broadcast({
            "@type": "foo",
            foo: "bar"
        });

        await sleep(20);

        expect(messageCount).to.be.equal(2);

        client1.stop();
        client2.stop();
        await server.stop();
    });

    it("can send message to specific client", async () => {
        const server = new VcmpServer({
            port: 12345,
        });
        server.onSessionConnected = session => {
            session.send({"@type": "foo"});
        }
        const client = createClient("ws://localhost:12345");
        let messageCount = 0;
        client.on("foo", () => { messageCount++ });
        await awaitConnected(client);

        await sleep(10);

        client.stop();
        await server.stop();

        expect(messageCount).to.be.equal(1);
    });

    it("can receive message from client", async () => {
        const server = new VcmpServer({
            port: 12345,
        });
        let messageCount = 0;
        server.on("foo", () => { messageCount++ });

        const client = await createConnectedClient("ws://localhost:12345");
        await client.send({"@type": "foo"});

        client.stop();
        await server.stop();

        expect(messageCount).to.be.equal(1);
    });

});


async function createConnectedClient(url: string) {
    const client = createClient(url);
    await awaitConnected(client);
    return client;
}

function createClient(url: string) {
    return new VcmpClient(url, {
        autoStart: true,
        customWebSocket: NodeWebSocket,
    })
}

function awaitConnected(client: VcmpClient) {
    return new Promise<void>((resolve) => {
        client.onOpen = () => resolve();
    });
}

function sleep(timeoutMs: number) {
    return new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
}