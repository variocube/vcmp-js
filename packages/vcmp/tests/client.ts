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

function sleep(timeoutMs: number) {
	return new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(5);
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

	it("closes the session when the server never initiates a heartbeat", async () => {
		ControlledWebSocket.instances = [];
		const client = new VcmpClient("ws://test", {
			customWebSocket: ControlledWebSocket as any,
			initialHeartbeatTimeout: 20,
		});
		client.start();
		const socket = ControlledWebSocket.instances[0];
		socket.open();
		expect(client.connected).to.be.true;
		await new Promise<void>(resolve => setTimeout(resolve, 80));
		// the session is gone (connected is undefined) rather than holding on to the abandoned socket
		expect(client.connected).to.not.be.true;
		client.stop();
	});

	it("reconnects promptly when the heartbeat watchdog abandons a connection that never closes", async () => {
		ControlledWebSocket.instances = [];
		const client = new VcmpClient("ws://test", {
			customWebSocket: ControlledWebSocket as any,
			initialHeartbeatTimeout: 20,
			reconnectTimeout: 20,
		});
		let closeEvents = 0;
		client.onClose = () => closeEvents++;
		client.start();
		const first = ControlledWebSocket.instances[0];
		first.open();
		const pending = client.send({"@type": "foo"});
		const rejected = pending.then(() => expect.fail("Expected error"), error => error);
		// ControlledWebSocket.close() never delivers a close event, like a black-holed connection:
		// the reconnect must not wait for it
		await waitFor(() => ControlledWebSocket.instances.length === 2);
		expect(closeEvents).to.be.equal(1);
		expect((await rejected).title).to.be.equal("Session closed");
		expect(ControlledWebSocket.instances).to.have.length(2);
		const second = ControlledWebSocket.instances[1];
		second.open();
		// the server initiates the heartbeat on the new connection, which keeps it alive
		second.onmessage?.({data: "HBT1000"});
		expect(client.connected).to.be.true;
		// the first socket's close event finally arrives and must neither notify nor reconnect
		first.fireClose();
		await sleep(60);
		expect(closeEvents).to.be.equal(1);
		expect(ControlledWebSocket.instances).to.have.length(2);
		expect(client.connected).to.be.true;
		client.stop();
		// deliver the close event, which clears the running heartbeat timer
		second.fireClose();
	});

	it("cancels a pending reconnect when start() is called", async () => {
		ControlledWebSocket.instances = [];
		const client = new VcmpClient("ws://test", {
			customWebSocket: ControlledWebSocket as any,
			reconnectTimeout: 30,
		});
		client.start();
		const first = ControlledWebSocket.instances[0];
		first.open();
		// the connection drops: a reconnect is scheduled...
		first.fireClose();
		// ...but the app reconnects right away instead of waiting for the timer
		client.start();
		const second = ControlledWebSocket.instances[1];
		second.open();
		expect(client.connected).to.be.true;
		// the previously scheduled reconnect must not open a third, duplicate connection
		await new Promise<void>(resolve => setTimeout(resolve, 100));
		expect(ControlledWebSocket.instances).to.have.length(2);
		expect(client.connected).to.be.true;
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
