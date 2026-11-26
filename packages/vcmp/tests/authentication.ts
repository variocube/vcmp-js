import {VcmpAuthenticationAck, VcmpClient, VcmpError, VcmpSession} from "@variocube/vcmp";
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
			authenticationTimeout: 1000,
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

	it("treats a credential provider that throws synchronously like a rejecting one", async () => {
		const errors: VcmpError[] = [];
		const client = createClient({
			// not async: throws before returning a promise
			authenticate: () => {
				throw new Error("no token");
			},
			reconnectTimeout: 1000,
		});
		client.onAuthenticationError = error => errors.push(error);
		const closed = new Promise<void>(resolve => client.onClose = () => resolve());
		client.start();
		await closed;
		expect(errors.map(error => error.status)).to.deep.equal([500]);
		await waitFor(() => server.connections[0]?.closed !== undefined);
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication failed"});
		expect(server.auts()).to.have.length(0);
	});

	it("handles a NAK 503 to the first AUT like any NAK: closes with 4008 and reconnects", async () => {
		server.onAut = (credential, connection) =>
			server.connections.indexOf(connection) == 0 ? `NAK{"title":"Overloaded","status":503}` : "ACK";
		const errors: VcmpError[] = [];
		const client = createClient({authenticate: async () => ({token: "t"})});
		client.onAuthenticationError = error => errors.push(error);
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		client.start();
		await opened;
		expect(errors.map(error => error.status)).to.deep.equal([503]);
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication failed"});
		expect(server.connections).to.have.length(2);
	});

	it("reports an authentication error when the server closes while the first AUT is pending", async () => {
		// e.g. an older server that closes the session on the unknown AUT
		server.onAut = (credential, connection) => {
			connection.webSocket.close();
			return undefined;
		};
		const events: string[] = [];
		const client = createClient({authenticate: async () => ({token: "t"}), reconnectTimeout: 5000});
		client.onAuthenticationError = error => events.push(`error:${error.status}`);
		client.onClose = () => events.push("close");
		let opened = false;
		client.onOpen = () => opened = true;
		client.start();
		await waitFor(() => events.includes("close"));
		expect(events).to.deep.equal(["error:503", "close"]);
		expect(opened).to.be.false;
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
		await waitFor(() => server.connections[0]?.closed !== undefined);
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication failed"});
	});

	it("times out a credential provider that never completes, closes and reconnects", async () => {
		let calls = 0;
		const errors: VcmpError[] = [];
		const client = createClient({
			authenticate: () => ++calls == 1 ? new Promise<object>(() => {}) : Promise.resolve({token: "t"}),
			authenticationTimeout: 1000,
		});
		client.onAuthenticationError = error => errors.push(error);
		const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
		const start = Date.now();
		client.start();
		await opened;
		expect(Date.now() - start).to.be.within(950, 2000);
		expect(errors.map(error => error.status)).to.deep.equal([504]);
		expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication timeout"});
		expect(server.auts(server.connections[0])).to.have.length(0);
		expect(calls).to.equal(2);
	});

	it("rejects an answer timeout below 1 s at construction", () => {
		const authenticate = async () => ({token: "t"});
		expect(() => new VcmpClient("ws://test", {authenticate, authenticationTimeout: 999})).to.throw(RangeError);
		expect(() => new VcmpClient("ws://test", {authenticate, authenticationTimeout: NaN})).to.throw(RangeError);
		expect(() => new VcmpClient("ws://test", {authenticate, authenticationTimeout: 1000})).to.not.throw();
	});

	describe("a malformed ACK", () => {
		for (
			const [name, payload, expected] of [
				["a payload that is not an object", "[1]", {}],
				["a string payload", "\"ok\"", {}],
				["an unparseable payload", "{oops", {}],
				["a negative expiresIn", "{\"expiresIn\":-5,\"user\":\"a\"}", {user: "a"}],
				["a fractional expiresIn", "{\"expiresIn\":1.5}", {}],
				["a string expiresIn", "{\"expiresIn\":\"2000\"}", {}],
			] as const
		) {
			it(`counts ${name} as absent, warns and authenticates`, async () => {
				server.onAut = () => `ACK${payload}`;
				const warnings: string[] = [];
				const collect = (...data: any[]) => warnings.push(data.map(String).join(" "));
				const client = createClient({
					authenticate: async () => ({token: "t"}),
					debug: {info: () => {}, debug: () => {}, warn: collect, error: collect},
				});
				const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
				client.start();
				await opened;
				expect(client.connected).to.be.true;
				expect(client.authentication).to.deep.equal(expected);
				expect(warnings.some(warning => /ACK payload|expiresIn/.test(warning))).to.be.true;
			});
		}
	});

	describe("reauthenticate()", () => {
		/** Starts a client against the fake server and waits until its first authentication is acknowledged. */
		async function startAuthenticated(options: Partial<ConstructorParameters<typeof VcmpClient>[1]> = {}) {
			const client = createClient({authenticate: async () => ({token: "t"}), ...options});
			const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
			client.start();
			await opened;
			return client;
		}

		it("sends one AUT with a fresh credential and resolves with the ACK payload", async () => {
			server.onAut = credential => `ACK{"expiresIn":60000,"token":"${credential.token}"}`;
			let calls = 0;
			const acks: VcmpAuthenticationAck[] = [];
			const client = await startAuthenticated({authenticate: async () => ({token: `t${++calls}`})});
			client.onAuthenticated = ack => acks.push(ack);
			let opens = 0;
			client.onOpen = () => opens++;
			const ack = await client.reauthenticate();
			expect(ack).to.deep.equal({expiresIn: 60000, token: "t2"});
			expect(acks).to.deep.equal([{expiresIn: 60000, token: "t2"}]);
			expect(client.authentication).to.deep.equal({expiresIn: 60000, token: "t2"});
			expect(server.auts().map(frame => JSON.parse(frame.slice(15)).token)).to.deep.equal(["t1", "t2"]);
			expect(opens).to.equal(0);
			expect(server.connections).to.have.length(1);
		});

		it("doesn't hold messages while the re-authentication is pending", async () => {
			let answer: (() => void) | undefined;
			server.onAut = (credential, connection, id) => {
				if (server.auts(connection).length == 1) {
					return "ACK";
				}
				answer = () => connection.webSocket.send(`ACK${id}`);
				return undefined;
			};
			const client = await startAuthenticated();
			const reauthenticated = client.reauthenticate();
			await waitFor(() => answer !== undefined);
			await client.send({"@type": "foo"});
			answer!();
			await reauthenticated;
		});

		it("never re-authenticates on its own, whatever the expiresIn", async () => {
			server.onAut = () => `ACK{"expiresIn":1000}`;
			await startAuthenticated();
			await sleep(1500);
			expect(server.auts()).to.have.length(1);
		});

		for (const status of [401, 403, 503]) {
			it(`rejects on a NAK ${status}, reports it, keeps the session and doesn't retry`, async () => {
				server.onAut = (credential, connection) =>
					server.auts(connection).length == 1 ? "ACK" : `NAK{"title":"No","status":${status}}`;
				const client = await startAuthenticated();
				const errors: number[] = [];
				client.onAuthenticationError = error => errors.push(error.status);
				const error = await client.reauthenticate().then(() => undefined, error => error);
				expect(error).to.be.instanceOf(VcmpError);
				expect(error.status).to.equal(status);
				expect(errors).to.deep.equal([status]);
				await sleep(200);
				expect(server.auts()).to.have.length(2);
				expect(server.connections[0].closed).to.be.undefined;
				expect(client.connected).to.be.true;
				await client.send({"@type": "foo"});
			});
		}

		it("rejects when the credential provider fails, sends nothing and keeps the session", async () => {
			let calls = 0;
			const client = await startAuthenticated({
				authenticate: () => {
					if (++calls == 2) {
						throw new Error("no token");
					}
					return {token: "t"};
				},
			});
			const errors: number[] = [];
			client.onAuthenticationError = error => errors.push(error.status);
			const error = await client.reauthenticate().then(() => undefined, error => error);
			expect(error.status).to.equal(500);
			expect(errors).to.deep.equal([500]);
			expect(server.auts()).to.have.length(1);
			expect(client.connected).to.be.true;
			await sleep(50);
			expect(server.connections[0].closed).to.be.undefined;
		});

		it("rejects when the credential provider doesn't complete in time, sends nothing and keeps the session", async () => {
			let calls = 0;
			let late: ((credential: object) => void) | undefined;
			const client = await startAuthenticated({
				authenticate: () => ++calls == 1 ? {token: "t"} : new Promise<object>(resolve => late = resolve),
				authenticationTimeout: 1000,
			});
			const start = Date.now();
			const error = await client.reauthenticate().then(() => undefined, error => error);
			expect(Date.now() - start).to.be.within(950, 1500);
			expect(error.status).to.equal(504);
			// the provider completing late sends nothing
			late!({token: "late"});
			await sleep(50);
			expect(server.auts()).to.have.length(1);
			expect(server.connections[0].closed).to.be.undefined;
			expect(client.connected).to.be.true;
		});

		it("closes with 4008 and reconnects when a sent AUT gets no answer", async () => {
			server.onAut = (credential, connection) =>
				server.connections.indexOf(connection) == 0 && server.auts(connection).length == 2 ? undefined : "ACK";
			const client = await startAuthenticated({authenticationTimeout: 1000});
			const errors: number[] = [];
			client.onAuthenticationError = error => errors.push(error.status);
			const reopened = new Promise<void>(resolve => client.onOpen = () => resolve());
			const error = await client.reauthenticate().then(() => undefined, error => error);
			expect(error.status).to.equal(504);
			expect(errors).to.deep.equal([504]);
			await reopened;
			expect(server.connections[0].closed).to.deep.equal({code: 4008, reason: "authentication timeout"});
			expect(server.auts(server.connections[0])).to.have.length(2);
		});

		it("coalesces calls while a re-authentication is pending into one further AUT with a fresh credential", async () => {
			const answers: Array<() => void> = [];
			server.onAut = (credential, connection, id) => {
				if (server.auts(connection).length == 1) {
					return "ACK";
				}
				answers.push(() => connection.webSocket.send(`ACK{"n":${answers.length}}`.replace("ACK", `ACK${id}`)));
				return undefined;
			};
			let calls = 0;
			const client = await startAuthenticated({authenticate: async () => ({token: `t${++calls}`})});
			const first = client.reauthenticate();
			await waitFor(() => answers.length == 1);
			const second = client.reauthenticate();
			const third = client.reauthenticate();
			await sleep(50);
			// only one AUT in flight
			expect(server.auts()).to.have.length(2);
			answers[0]();
			expect(await first).to.deep.equal({n: 1});
			await waitFor(() => answers.length == 2);
			expect(server.auts()).to.have.length(3);
			expect(JSON.parse(server.auts()[2].slice(15))).to.deep.equal({token: "t3"});
			answers[1]();
			expect(await second).to.deep.equal({n: 2});
			expect(await third).to.deep.equal({n: 2});
			await sleep(50);
			expect(server.auts()).to.have.length(3);
		});

		it("serves a call made while the first AUT is pending with one further AUT after its ACK", async () => {
			let release: (() => void) | undefined;
			server.onAut = (credential, connection, id) => {
				if (server.auts(connection).length == 1) {
					release = () => connection.webSocket.send(`ACK${id}`);
					return undefined;
				}
				return `ACK{"second":true}`;
			};
			const client = createClient({authenticate: async () => ({token: "t"})});
			client.start();
			await waitFor(() => release !== undefined);
			const reauthenticated = client.reauthenticate();
			await sleep(30);
			expect(server.auts()).to.have.length(1);
			release!();
			expect(await reauthenticated).to.deep.equal({second: true});
			expect(server.auts()).to.have.length(2);
		});

		it("resolves without sending when the first AUT it waited for fails", async () => {
			let reject: (() => void) | undefined;
			server.onAut = (credential, connection, id) => {
				reject = () => connection.webSocket.send(`NAK${id}{"title":"No","status":401}`);
				return undefined;
			};
			const client = createClient({authenticate: async () => ({token: "t"}), reconnectTimeout: 5000});
			client.onAuthenticationError = () => {};
			client.start();
			await waitFor(() => reject !== undefined);
			const reauthenticated = client.reauthenticate();
			reject!();
			expect(await reauthenticated).to.be.undefined;
			await sleep(50);
			expect(server.auts()).to.have.length(1);
		});

		it("resolves without sending when there is no authenticated session", async () => {
			const client = createClient({authenticate: async () => ({token: "t"})});
			// not started
			expect(await client.reauthenticate()).to.be.undefined;
			// connecting
			server.onAut = () => "ACK";
			const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
			client.start();
			expect(await client.reauthenticate()).to.be.undefined;
			await opened;
			expect(server.auts()).to.have.length(1);
			// stopped
			client.stop();
			expect(await client.reauthenticate()).to.be.undefined;
			// without the authenticate option
			const plain = new VcmpClient(server.url, {customWebSocket: WebSocket});
			expect(await plain.reauthenticate()).to.be.undefined;
		});

		it("resolves without sending on an open session that hasn't authenticated", async () => {
			// a session on an already open socket: no first AUT was started
			const sent: string[] = [];
			const session = new VcmpSession({
				webSocket: {readyState: 1, send: (data: string) => sent.push(data), close() {}} as any,
				resolver: () => undefined,
				clientAuthentication: {authenticate: () => ({token: "t"}), timeout: 1000},
			});
			expect(await session.reauthenticate()).to.be.undefined;
			await sleep(20);
			expect(sent).to.deep.equal([]);
		});

		it("gives coalesced calls the outcome of the AUT a handler started meanwhile", async () => {
			// an application whose error handler retries at once: its call starts the further AUT before the
			// coalesced calls are served, which then must get that AUT's outcome, not `undefined`
			const sent: string[] = [];
			const webSocket: any = {
				readyState: 1,
				send: (data: string) => sent.push(data),
				close() {},
			};
			let calls = 0;
			const session = new VcmpSession({
				webSocket,
				resolver: () => undefined,
				clientAuthentication: {authenticate: () => ({token: `t${++calls}`}), timeout: 5000},
			});
			const auts = () => sent.filter(frame => frame.startsWith("AUT"));
			const answer = (index: number, frame: string) =>
				webSocket.onmessage({data: frame.replace("#", auts()[index].slice(3, 15))});
			webSocket.onopen();
			await waitFor(() => auts().length == 1);
			answer(0, "ACK#");

			let retry: Promise<unknown> | undefined;
			session.onAuthenticationError = () => {
				retry ??= session.reauthenticate();
			};
			const a = session.reauthenticate().then(() => undefined, error => error);
			await waitFor(() => auts().length == 2);
			const b = session.reauthenticate();
			answer(1, `NAK#{"title":"Invalid","status":401}`);
			await waitFor(() => auts().length == 3);
			expect(JSON.parse(auts()[2].slice(15))).to.deep.equal({token: "t3"});
			answer(2, `ACK#{"n":3}`);
			expect((await a).status).to.equal(401);
			expect(await b).to.deep.equal({n: 3});
			expect(await retry).to.deep.equal({n: 3});
			await sleep(20);
			expect(auts()).to.have.length(3);
		});

		it("rejects and reports when the session closes while the re-authentication is pending", async () => {
			server.onAut = (credential, connection) => server.auts(connection).length == 1 ? "ACK" : undefined;
			const client = await startAuthenticated({reconnectTimeout: 5000});
			const events: string[] = [];
			const errors: VcmpError[] = [];
			client.onAuthenticationError = error => {
				errors.push(error);
				events.push(`error:${error.status}`);
			};
			client.onClose = () => events.push("close");
			const reauthenticated = client.reauthenticate().then(() => undefined, error => error);
			await waitFor(() => server.auts().length == 2);
			server.connections[0].webSocket.close();
			const error = await reauthenticated;
			expect(error.status).to.equal(503);
			expect(errors).to.deep.equal([error]);
			expect(events).to.deep.equal(["error:503", "close"]);
		});
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
			authenticationTimeout: 1000,
			initialHeartbeatTimeout: 0,
		});
		client.onAuthenticationError = error => errors.push(error);
		let opens = 0;
		client.onOpen = () => opens++;
		client.start();
		SyncAckWebSocket.instances[0].open();
		await waitFor(() => opens == 1);
		await sleep(1100);
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
