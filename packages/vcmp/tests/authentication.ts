import {
	computeRefreshDelay,
	defaultRefreshLeadTime,
	VcmpAuthenticationAck,
	VcmpClient,
	VcmpError,
} from "@variocube/vcmp";
import {expect} from "chai";
import {AddressInfo} from "net";
import WebSocket, {WebSocketServer} from "ws";

/** One connection to the fake server: the raw frames the client sent, and a way to answer them. */
interface Connection {
	webSocket: WebSocket;
	frames: string[];
	closed?: { code: number; reason: string };
}

/**
 * A minimal VCMP server speaking raw frames. `onAut` decides how an AUT is answered: with the frame to
 * send back (the id is filled in), or `undefined` to never answer (an older server that doesn't know AUT).
 */
class FakeServer {
	readonly connections: Connection[] = [];
	onAut: (credential: any, connection: Connection, id: string) => string | undefined = () => "ACK";

	private constructor(private readonly webSocketServer: WebSocketServer) {
		webSocketServer.on("connection", webSocket => {
			const connection: Connection = {webSocket, frames: []};
			this.connections.push(connection);
			webSocket.on("close", (code, reason) => connection.closed = {code, reason: String(reason)});
			webSocket.on("message", data => {
				const frame = String(data);
				connection.frames.push(frame);
				const id = frame.slice(3, 15);
				if (frame.startsWith("AUT")) {
					const answer = this.onAut(JSON.parse(frame.slice(15)), connection, id);
					if (answer !== undefined) {
						webSocket.send(answer.slice(0, 3) + id + answer.slice(3));
					}
				}
				else if (frame.startsWith("MSG")) {
					webSocket.send(`ACK${id}`);
				}
			});
			// initiate the heartbeat, as servers do
			webSocket.send("HBT20000");
		});
	}

	static async start() {
		const webSocketServer = new WebSocketServer({port: 0});
		await new Promise<void>(resolve => webSocketServer.on("listening", () => resolve()));
		return new FakeServer(webSocketServer);
	}

	get url() {
		return `ws://localhost:${(this.webSocketServer.address() as AddressInfo).port}`;
	}

	auts(connection: Connection | undefined = this.connections[0]) {
		return (connection?.frames ?? []).filter(frame => frame.startsWith("AUT"));
	}

	msgs(connection: Connection | undefined = this.connections[0]) {
		return (connection?.frames ?? []).filter(frame => frame.startsWith("MSG"));
	}

	stop() {
		this.webSocketServer.clients.forEach(client => client.terminate());
		return new Promise<void>(resolve => this.webSocketServer.close(() => resolve()));
	}
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
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

/**
 * A `ws` WebSocket that enforces the browser's (WHATWG) rule for close codes, which `ws` doesn't: a client may
 * only close with 1000 or 3000–4999, anything else throws an InvalidAccessError.
 */
class BrowserLikeWebSocket extends WebSocket {
	close(code?: number, reason?: string) {
		if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
			const error = new Error(
				`Failed to execute 'close' on 'WebSocket': The code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
			);
			error.name = "InvalidAccessError";
			throw error;
		}
		super.close(code, reason);
	}
}

/** A socket that answers every AUT synchronously from within send(), like an in-memory loopback. */
class SyncAckWebSocket {
	static instances: SyncAckWebSocket[] = [];
	readyState = 0;
	onopen?: () => void;
	onclose?: (event: any) => void;
	onmessage?: (event: any) => void;
	onerror?: () => void;

	constructor(url: string) {
		SyncAckWebSocket.instances.push(this);
	}

	send(data: string) {
		if (data.startsWith("AUT")) {
			this.onmessage?.({data: `ACK${data.slice(3, 15)}`});
		}
	}

	close() {
		this.readyState = 3;
		this.onclose?.({type: "close", code: 1000, reason: ""});
	}

	open() {
		this.readyState = 1;
		this.onopen?.();
	}
}

describe("VcmpClient authentication", function() {
	this.timeout(10000);

	let server: FakeServer;
	let client: VcmpClient | undefined;

	beforeEach(async () => {
		server = await FakeServer.start();
	});

	afterEach(async () => {
		client?.stop();
		client = undefined;
		await server.stop();
	});

	function createClient(options: Partial<ConstructorParameters<typeof VcmpClient>[1]>) {
		client = new VcmpClient(server.url, {customWebSocket: WebSocket, reconnectTimeout: 20, ...options});
		return client;
	}

	it("sends AUT first, holds messages until the ACK and raises onOpen only then", async () => {
		let release!: () => void;
		server.onAut = (credential, connection, id) => {
			// answer later, to observe the hold
			release = () => connection.webSocket.send(`ACK${id}{"user":"alice"}`);
			return undefined;
		};
		const events: string[] = [];
		const client = createClient({authenticate: async () => ({token: "t1"})});
		client.onOpen = () => events.push(`open:${client.connected}`);
		client.onAuthenticated = ack => events.push(`authenticated:${ack.user}`);
		client.start();
		await waitFor(() => server.connections.length == 1 && server.auts().length == 1);
		const sent = client.send({"@type": "early"});
		await sleep(30);
		expect(client.connected).to.be.false;
		expect(events).to.deep.equal([]);
		expect(server.connections[0].frames.filter(frame => !frame.startsWith("HBT"))).to.have.length(1);
		expect(JSON.parse(server.auts()[0].slice(15))).to.deep.equal({token: "t1"});

		release();
		await sent;
		expect(server.msgs()).to.have.length(1);
		// AUT was the first frame, the held MSG followed the ACK
		expect(server.connections[0].frames.filter(frame => !frame.startsWith("HBT"))[0]).to.match(/^AUT/);
		expect(events).to.deep.equal(["authenticated:alice", "open:true"]);
		expect(client.authentication).to.deep.equal({user: "alice"});
	});

	it("reports a NAK as an authentication error, closes and reconnects with a fresh credential", async () => {
		server.onAut = credential => credential.token == "t2" ? "ACK" : `NAK{"title":"Invalid","status":401}`;
		let calls = 0;
		const errors: VcmpError[] = [];
		const client = createClient({authenticate: async () => ({token: `t${++calls}`})});
		client.onAuthenticationError = error => errors.push(error);
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		expect(errors.map(error => [error.status, error.title])).to.deep.equal([[401, "Invalid"]]);
		expect(server.connections).to.have.length(2);
		// a client closes with 4008: browsers don't let a client close with 1008
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication failed"});
		expect(server.msgs(server.connections[0])).to.have.length(0);
		expect(calls).to.equal(2);
	});

	it("reports a missing answer as an authentication timeout and never sends MSG", async () => {
		server.onAut = () => undefined;
		const errors: VcmpError[] = [];
		const client = createClient({
			authenticate: async () => ({token: "t"}),
			authenticationTimeout: 50,
			reconnectTimeout: 1000,
		});
		client.onAuthenticationError = error => errors.push(error);
		let opened = false;
		client.onOpen = () => opened = true;
		const closed = new Promise<void>(resolve => client.onClose = () => resolve());
		client.start();
		await waitFor(() => server.auts().length == 1);
		const sent = client.send({"@type": "foo"}).then(() => undefined, error => error);
		await closed;
		expect(errors.map(error => error.status)).to.deep.equal([504]);
		expect(((await sent) as VcmpError).status).to.equal(503);
		expect(server.msgs()).to.have.length(0);
		expect(opened).to.be.false;
		await waitFor(() => server.connections[0].closed !== undefined);
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication timeout"});
	});

	it("reports a failing credential provider and closes the session", async () => {
		const errors: VcmpError[] = [];
		const client = createClient({
			authenticate: async () => {
				throw new Error("no token");
			},
			reconnectTimeout: 1000,
		});
		client.onAuthenticationError = error => errors.push(error);
		const closed = new Promise<void>(resolve => client.onClose = () => resolve());
		client.start();
		await closed;
		expect(errors.map(error => error.status)).to.deep.equal([500]);
		expect(server.auts()).to.have.length(0);
	});

	it("re-authenticates at the lead time before the expiry, without holding messages", async () => {
		const autTimes: number[] = [];
		server.onAut = () => {
			autTimes.push(Date.now());
			return `ACK{"expiresIn":1500,"n":${autTimes.length}}`;
		};
		const acks: VcmpAuthenticationAck[] = [];
		const client = createClient({authenticate: async () => ({token: "t"}), refreshLeadTime: 100});
		client.onAuthenticated = ack => acks.push(ack);
		let opens = 0;
		client.onOpen = () => opens++;
		client.start();
		await waitFor(() => autTimes.length == 2, 3000);
		// refreshed 1500 - 100 ms after the first ACK (the default lead time would be 300 ms)
		expect(autTimes[1] - autTimes[0]).to.be.within(1350, 1600);
		// messages flow while refreshing
		await client.send({"@type": "foo"});
		await waitFor(() => acks.length == 3, 3000);
		expect(acks.map(ack => ack.n)).to.deep.equal([1, 2, 3]);
		expect(opens).to.equal(1);
		expect(server.connections).to.have.length(1);
		expect(client.authentication).to.deep.equal({expiresIn: 1500, n: 3});
	});

	it("bounds the refresh delay: lead time at most expiresIn / 2, never sooner than 1 s", () => {
		expect(computeRefreshDelay(300000)).to.equal(240000);
		expect(computeRefreshDelay(10000, 2000)).to.equal(8000);
		expect(computeRefreshDelay(10000, expiresIn => expiresIn / 4)).to.equal(7500);
		// a lead time beyond half the lifetime is clamped
		expect(computeRefreshDelay(10000, 60000)).to.equal(5000);
		expect(computeRefreshDelay(10000, () => 60000)).to.equal(5000);
		// an invalid lead time falls back to the default
		expect(computeRefreshDelay(10000, () => NaN)).to.equal(8000);
		expect(computeRefreshDelay(10000, -5)).to.equal(8000);
		expect(computeRefreshDelay(10000, () => {
			throw new Error("boom");
		})).to.equal(8000);
		// never sooner than 1 s after the ACK
		expect(computeRefreshDelay(500, 0)).to.equal(1000);
		expect(computeRefreshDelay(0)).to.equal(1000);
		expect(computeRefreshDelay(1000)).to.equal(1000);
	});

	it("defaults the lead time to min(60 s, 20 % of expiresIn)", () => {
		expect(defaultRefreshLeadTime(1000)).to.equal(200);
		expect(defaultRefreshLeadTime(300000)).to.equal(60000);
		expect(defaultRefreshLeadTime(3600000)).to.equal(60000);
	});

	it("keeps the session when the refreshLeadTime function throws", async () => {
		server.onAut = () => `ACK{"expiresIn":60000}`;
		const client = createClient({
			authenticate: async () => ({token: "t"}),
			refreshLeadTime: () => {
				throw new Error("boom");
			},
		});
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		expect(client.connected).to.be.true;
		await client.send({"@type": "foo"});
		expect(server.msgs()).to.have.length(1);
	});

	it("doesn't refresh without expiresIn", async () => {
		server.onAut = () => "ACK";
		createClient({authenticate: async () => ({token: "t"})}).start();
		await waitFor(() => server.auts().length == 1);
		await sleep(100);
		expect(server.auts()).to.have.length(1);
	});

	it("retries a refresh answered with NAK 401 until the expiry", async () => {
		server.onAut = (credential, connection) =>
			server.auts(connection).length == 1 ? `ACK{"expiresIn":1600}` : `NAK{"title":"Invalid","status":401}`;
		const errors: number[] = [];
		const client = createClient({
			authenticate: async () => ({token: "t"}),
			refreshLeadTime: 600,
			refreshRetryDelay: 100,
		});
		client.onAuthenticationError = error => errors.push(error.status);
		client.start();
		await sleep(1900);
		// refresh at 1000 ms, retries every 100 ms while before the expiry at 1600 ms
		const auts = server.auts().length;
		expect(auts).to.be.within(5, 8);
		expect(errors.every(status => status == 401)).to.be.true;
		expect(errors).to.have.length(auts - 1);
		// the session stays open (the server would close it at the expiry)
		expect(client.connected).to.be.true;
	});

	it("retries a refresh answered with NAK 403 until the expiry", async () => {
		// a 403 without a principal change: the server keeps the session until its old expiry
		server.onAut = (credential, connection) =>
			server.auts(connection).length == 1 ? `ACK{"expiresIn":1600}` : `NAK{"title":"Forbidden","status":403}`;
		const errors: number[] = [];
		const client = createClient({
			authenticate: async () => ({token: "t"}),
			refreshLeadTime: 600,
			refreshRetryDelay: 100,
		});
		client.onAuthenticationError = error => errors.push(error.status);
		client.start();
		await sleep(1900);
		expect(server.auts().length).to.be.within(5, 8);
		expect(errors.every(status => status == 403)).to.be.true;
		expect(server.connections).to.have.length(1);
	});

	it("closes and reconnects instead of retrying when a refresh gets no answer", async () => {
		server.onAut = (credential, connection) =>
			server.auts(connection).length == 1 ? `ACK{"expiresIn":2000}` : undefined;
		const errors: number[] = [];
		let calls = 0;
		const client = createClient({
			authenticate: async () => ({token: `t${++calls}`}),
			authenticationTimeout: 50,
			refreshLeadTime: 1900,
			refreshRetryDelay: 10,
		});
		client.onAuthenticationError = error => errors.push(error.status);
		let closes = 0;
		client.onClose = () => closes++;
		client.start();
		await waitFor(() => server.connections.length == 2 && server.auts(server.connections[1]).length == 1, 3000);
		const first = server.connections[0];
		await waitFor(() => first.closed !== undefined);
		// the refresh was sent once, never retried on the session that may still be processing it
		expect(server.auts(first)).to.have.length(2);
		expect(first.closed).to.deep.equal({code: 4008, reason: "authentication timeout"});
		expect(errors).to.deep.equal([504]);
		expect(closes).to.equal(1);
		// reconnected with a fresh credential
		expect(JSON.parse(server.auts(server.connections[1])[0].slice(15))).to.deep.equal({token: "t3"});
	});

	for (
		const [name, webSocket] of [
			["a WebSocket enforcing the browser's close codes", BrowserLikeWebSocket],
			["Node's global (WHATWG) WebSocket", (globalThis as any).WebSocket],
		] as const
	) {
		it(`closes with 4008 on ${name}`, async function() {
			if (!webSocket) {
				this.skip();
			}
			server.onAut = () => `NAK{"title":"Invalid","status":401}`;
			const warnings: string[] = [];
			const collect = (...data: any[]) => warnings.push(data.map(String).join(" "));
			const client = createClient({
				customWebSocket: webSocket,
				authenticate: async () => ({token: "t"}),
				reconnectTimeout: 1000,
				debug: {info: () => {}, debug: () => {}, warn: collect, error: collect},
			});
			client.start();
			await waitFor(() => server.connections[0]?.closed !== undefined);
			expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication failed"});
			expect(warnings.filter(warning => warning.includes("Could not close"))).to.deep.equal([]);
		});
	}

	it("doesn't time out an authentication answered synchronously during send", async () => {
		SyncAckWebSocket.instances = [];
		const errors: VcmpError[] = [];
		const client = new VcmpClient("ws://test", {
			customWebSocket: SyncAckWebSocket as any,
			authenticate: () => ({token: "t"}),
			authenticationTimeout: 30,
			initialHeartbeatTimeout: 0,
		});
		client.onAuthenticationError = error => errors.push(error);
		let opens = 0;
		client.onOpen = () => opens++;
		client.start();
		SyncAckWebSocket.instances[0].open();
		await waitFor(() => opens == 1);
		await sleep(80);
		expect(errors).to.deep.equal([]);
		expect(client.connected).to.be.true;
		client.stop();
	});

	it("calls the credential provider on every reconnect", async () => {
		let calls = 0;
		const client = createClient({authenticate: async () => ({token: `t${++calls}`})});
		let opens = 0;
		client.onOpen = () => opens++;
		client.start();
		await waitFor(() => opens == 1);
		server.connections[0].webSocket.close();
		await waitFor(() => opens == 2);
		expect(calls).to.equal(2);
		expect(JSON.parse(server.auts(server.connections[1])[0].slice(15))).to.deep.equal({token: "t2"});
	});

	it("never writes the credential to debug output", async () => {
		const logged: string[] = [];
		const collect = (...data: any[]) => logged.push(data.map(item => JSON.stringify(item)).join(" "));
		const client = createClient({
			authenticate: async () => ({token: "s3cr3t"}),
			debug: {info: collect, debug: collect, warn: collect, error: collect},
		});
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		expect(logged.join("\n")).to.contain("AUT");
		expect(logged.join("\n")).to.not.contain("s3cr3t");
	});

	it("behaves as before without authenticate", async () => {
		const client = createClient({});
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		expect(client.connected).to.be.true;
		await client.send({"@type": "foo"});
		expect(server.auts()).to.have.length(0);
	});

	it("answers an AUT from the server with NAK 400", async () => {
		const client = createClient({});
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		const connection = server.connections[0];
		connection.webSocket.send(`AUTauth00000001{"token":"x"}`);
		await waitFor(() => connection.frames.some(frame => frame.startsWith("NAKauth00000001")));
		const nak = connection.frames.find(frame => frame.startsWith("NAKauth00000001"))!;
		expect(JSON.parse(nak.slice(15)).status).to.equal(400);
	});
});
