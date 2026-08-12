import {VcmpError, VcmpSession} from "@variocube/vcmp";
import {expect} from "chai";

class FakeWebSocket {
	readyState = 1; // OPEN
	sent: string[] = [];
	onopen?: () => void;
	onclose?: (event: any) => void;
	onmessage?: (event: any) => void;
	onerror?: () => void;

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3; // CLOSED
		this.onclose?.({type: "close", code: 1000, reason: ""});
	}

	receive(data: string) {
		this.onmessage?.({data});
	}
}

/** Delivers the ACK synchronously from within send(), like an in-memory loopback socket. */
class SyncAckWebSocket extends FakeWebSocket {
	send(data: string) {
		super.send(data);
		if (data.startsWith("MSG")) {
			this.receive(`ACK${data.slice(3, 15)}"pong"`);
		}
	}
}

function createSession(webSocket: FakeWebSocket, resolver: (type: string) => any = () => undefined) {
	return new VcmpSession({webSocket: webSocket as any, resolver});
}

function sentFrameId(rawFrame: string) {
	return rawFrame.slice(3, 15);
}

function sleep(timeoutMs: number) {
	return new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
}

describe("VcmpSession", () => {
	it("rejects pending sends when the session closes", async () => {
		const webSocket = new FakeWebSocket();
		const session = createSession(webSocket);
		const pending = session.send({"@type": "foo"});
		webSocket.close();
		try {
			await pending;
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(503);
			expect(error.title).to.be.equal("Session closed");
		}
	});

	it("rejects sends when the socket is not open", async () => {
		const webSocket = new FakeWebSocket();
		webSocket.readyState = 0; // CONNECTING
		const session = createSession(webSocket);
		try {
			await session.send({"@type": "foo"});
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(503);
			expect(error.title).to.be.equal("Session not open");
		}
	});

	it("resolves a send whose ACK is delivered synchronously during send", async () => {
		const webSocket = new SyncAckWebSocket();
		const session = createSession(webSocket);
		const result = await session.send({"@type": "foo"});
		expect(result).to.be.equal("pong");
	});

	it("rejects with the thrown error when the socket's send throws synchronously", async () => {
		const webSocket = new FakeWebSocket();
		webSocket.send = () => {
			throw new Error("boom");
		};
		const session = createSession(webSocket);
		try {
			await session.send({"@type": "foo"});
			expect.fail("Expected error");
		}
		catch (error) {
			expect((error as Error).message).to.be.equal("boom");
		}
	});

	it("rejects a send whose ACK payload cannot be parsed", async () => {
		const webSocket = new FakeWebSocket();
		const session = createSession(webSocket);
		const pending = session.send({"@type": "foo"});
		webSocket.receive(`ACK${sentFrameId(webSocket.sent[0])}{oops`);
		try {
			await pending;
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(500);
			expect(error.title).to.be.equal("Invalid acknowledgement");
			expect(error.cause).to.be.instanceOf(SyntaxError);
		}
	});

	it("NAKs an inbound message with an unparseable payload", () => {
		const webSocket = new FakeWebSocket();
		createSession(webSocket);
		webSocket.receive("MSGabcdefghijkl{oops");
		expect(webSocket.sent).to.have.length(1);
		const nak = webSocket.sent[0];
		expect(nak.slice(0, 3)).to.be.equal("NAK");
		expect(sentFrameId(nak)).to.be.equal("abcdefghijkl");
		expect(JSON.parse(nak.slice(15)).status).to.be.equal(400);
	});

	it("NAKs an inbound message without a type", () => {
		const webSocket = new FakeWebSocket();
		createSession(webSocket);
		webSocket.receive(`MSGabcdefghijkl{"foo":"bar"}`);
		expect(webSocket.sent).to.have.length(1);
		const nak = webSocket.sent[0];
		expect(nak.slice(0, 3)).to.be.equal("NAK");
		expect(JSON.parse(nak.slice(15)).status).to.be.equal(400);
	});

	it("ignores an invalid frame without throwing", () => {
		const webSocket = new FakeWebSocket();
		createSession(webSocket);
		webSocket.receive("XXXsomething");
		expect(webSocket.sent).to.have.length(0);
		expect(webSocket.readyState).to.be.equal(1);
	});

	it("closes the session when the initiated heartbeat is never answered", async () => {
		const webSocket = new FakeWebSocket();
		const session = createSession(webSocket);
		const pending = session.send({"@type": "foo"});
		session.initiateHeartbeat(10);
		// the watchdog (2 x interval) must close the session even though no heartbeat
		// was ever received
		await sleep(50);
		expect(webSocket.readyState).to.be.equal(3);
		try {
			await pending;
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(503);
			expect(error.title).to.be.equal("Session closed");
		}
	});

	it("keeps the session open while heartbeats are answered", async () => {
		const webSocket = new FakeWebSocket();
		const session = createSession(webSocket);
		session.initiateHeartbeat(100);
		webSocket.receive("HBT100");
		await sleep(150);
		// after the interval, the next heartbeat went out and its watchdog (200 ms) is
		// still pending — the session must not have been closed
		expect(webSocket.sent.filter(frame => frame.startsWith("HBT"))).to.have.length(2);
		expect(webSocket.readyState).to.be.equal(1);
		session.close();
	});
});
