import {VcmpClient, VcmpServer} from "../src";
import {expect} from "chai";
import * as NodeWebSocket from "ws";

describe("VcmpServer", () => {
    it("can instantiate and close", () => {
        const server = new VcmpServer({
            port: 12345,
        });
        server.close();
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

        await sleep(100);

        expect(messageCount).to.be.equal(2);

        client1.stop();
        client2.stop();
        server.close();
    });
})


function createConnectedClient(url: string) {
    return new Promise<VcmpClient>((resolve, reject) => {
        const client = new VcmpClient(url, {
            autoStart: true,
            customWebSocket: NodeWebSocket,
        });
        client.onOpen = () => resolve(client);
    })
}

function sleep(timeoutMs: number) {
    return new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
}