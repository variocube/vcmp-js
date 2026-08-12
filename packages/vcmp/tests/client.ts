import {VcmpClient} from "@variocube/vcmp";
import {expect} from "chai";
import WebSocket from "ws";

interface SampleMessage {
	"@type": "SampleType";
}

/** A controllable fake socket whose close event is delivered explicitly, like a real socket's. */
class ControlledWebSocket {
	static instances: ControlledWebSocket[] = [];
	readyState = 0; // CONNECTING
	onopen?: () => void;
	onclose?: (event: any) => void;
	onmessage?: (event: any) => void;
	onerror?: () => void;

	constructor(url: string) {
		ControlledWebSocket.instances.push(this);
	}

	send(data: string) {}

	close() {
		this.readyState = 3; // CLOSED; the close event arrives separately via fireClose()
	}

	open() {
		this.readyState = 1; // OPEN
		this.onopen?.();
	}

	fireClose() {
		this.readyState = 3;
		this.onclose?.({type: "close", code: 1006, reason: ""});
	}
}

describe("VcmpClient", () => {
	it("can instantiate client and start/stop", () => {
		const client = new VcmpClient("ws://localhost:22", {
			customWebSocket: WebSocket,
		});
		client.start();
		setTimeout(() => client.stop(), 10);
	});

	it("can instantiate client and start/stop 2", () => {
		const client = new VcmpClient("ws://localhost:12345", {
			customWebSocket: WebSocket,
		});
		client.start();
		setTimeout(() => client.stop(), 10);
	});

	it("can attach listener", () => {
		const client = new VcmpClient("ws://localhost:22");
		client.on("sometype", () => {});
	});

	it("can call send, but fails", async () => {
		const client = new VcmpClient("ws://localhost:22");
		expect(async () => {
			await client.send({"@type": "nonExistantMessageType", "foo": "bar"});
		}).to.throw;
	});

	it("accepts console for debug", async () => {
		new VcmpClient("ws://localhost:22", {
			debug: console,
		});
	});

	it("keeps the new session when the old socket's close event arrives after a restart", async () => {
		ControlledWebSocket.instances = [];
		const client = new VcmpClient("ws://test", {
			customWebSocket: ControlledWebSocket as any,
			reconnectTimeout: 20,
		});
		client.start();
		const first = ControlledWebSocket.instances[0];
		first.open();
		client.stop();
		client.start();
		const second = ControlledWebSocket.instances[1];
		second.open();
		expect(client.connected).to.be.true;
		// the first socket's close event arrives only now (it is asynchronous in real life)
		// and must neither discard the new session nor schedule a reconnect
		first.fireClose();
		expect(client.connected).to.be.true;
		await new Promise<void>(resolve => setTimeout(resolve, 60));
		expect(ControlledWebSocket.instances).to.have.length(2);
		client.stop();
	});

	it("writes to debug object", async () => {
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
	});
});
