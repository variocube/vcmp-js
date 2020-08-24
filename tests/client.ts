import {VcmpClient} from "../src";
import { expect } from "chai";

interface SampleMessage {
    "@type": "SampleType"
}

describe('VcmpClient', () => {
    it('can instantiate client and start/stop', () => {
        const client = new VcmpClient("ws://localhost:22", {
            customWebSocket: require("ws")
        });
        client.start();
        client.stop();
    });

    it('can attach listener', () => {
        const client = new VcmpClient("ws://localhost:22");
        client.on("sometype", (message: SampleMessage) => {})
    });

    it('can call send, but fails', async () => {
        const client = new VcmpClient("ws://localhost:22");
        expect(async () => {
            await client.send({ "@type": "nonExistantMessageType", "foo": "bar"});
        }).to.throw;
    })
});