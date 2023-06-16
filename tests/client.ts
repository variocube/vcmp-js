import {VcmpClient} from "../src/client.js";
import { expect } from "chai";
import WebSocket from "ws";

interface SampleMessage {
    "@type": "SampleType"
}

describe('VcmpClient', () => {
    it('can instantiate client and start/stop', () => {
        const client = new VcmpClient("ws://localhost:22", {
            customWebSocket: WebSocket
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

    it('accepts console for debug', async () => {
        new VcmpClient("ws://localhost:22", {
            debug: console,
        });
    })

    it('writes to debug object', async () => {
        let messageCount = 0;
        const incMessageCount = () => messageCount++;
        new VcmpClient("ws://localhost:22", {
            debug: {
                info: incMessageCount,
                debug: incMessageCount,
                error: incMessageCount,
                warn: incMessageCount,
            },
        });
        expect(messageCount).to.be.greaterThan(0);
    })
});