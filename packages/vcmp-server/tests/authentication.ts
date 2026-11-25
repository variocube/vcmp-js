import {VcmpAuthentication, VcmpClient, VcmpCredential, VcmpError, VcmpSession} from "@variocube/vcmp";
import {expect} from "chai";
import {AddressInfo} from "net";
import NodeWebSocket, {WebSocketServer} from "ws";
import {VcmpServer, VcmpServerAuthentication, VcmpServerOptions} from "../src";

/** A peer that speaks raw VCMP frames, to drive the server rules frame by frame. */
class RawPeer {
	readonly frames: string[] = [];
	readonly closed: Promise<{ code: number; reason: string }>;
	private readonly waiters: Array<() => void> = [];

	private constructor(readonly webSocket: NodeWebSocket) {
		webSocket.on("message", data => {
			this.frames.push(String(data));
			this.waiters.splice(0).forEach(waiter => waiter());
		});
		this.closed = new Promise(resolve =>
			webSocket.on("close", (code, reason) => resolve({code, reason: String(reason)}))
		);
	}

	static connect(url: string) {
		const webSocket = new NodeWebSocket(url);
		const peer = new RawPeer(webSocket);
		return new Promise<RawPeer>((resolve, reject) => {
			webSocket.on("open", () => resolve(peer));
			webSocket.on("error", reject);
		});
	}

	send(frame: string) {
		this.webSocket.send(frame);
	}

	aut(id: string, credential: unknown) {
		this.send(`AUT${id}${typeof credential == "string" ? credential : JSON.stringify(credential)}`);
	}

	msg(id: string, message: object) {
		this.send(`MSG${id}${JSON.stringify(message)}`);
	}

	/** Waits for a frame starting with the given prefix and returns its payload (after the id). */
	async expectFrame(prefix: string, timeoutMs = 1000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const frame = this.frames.find(frame => frame.startsWith(prefix));
			if (frame) {
				this.frames.splice(this.frames.indexOf(frame), 1);
				return frame.slice(15);
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(`No frame ${prefix} within ${timeoutMs} ms; received: ${this.frames.join(", ")}`);
			}
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, remaining);
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	hasFrame(prefix: string) {
		return this.frames.some(frame => frame.startsWith(prefix));
	}

	async expectClose(timeoutMs = 1000) {
		return await Promise.race([
			this.closed,
			sleep(timeoutMs).then(() => {
				throw new Error(`Not closed within ${timeoutMs} ms`);
			}),
		]);
	}

	async expectOpenFor(ms: number) {
		const result = await Promise.race([this.closed, sleep(ms).then(() => "open" as const)]);
		expect(result, "session closed unexpectedly").to.equal("open");
	}

	close() {
		this.webSocket.close();
	}
}

interface Principal {
	user: string;
}

/** Tokens: `valid:<user>[:<expiresInMs>]`; anything else is invalid. */
function tokenAuthenticator(credential: VcmpCredential): VcmpAuthentication<Principal> {
	const [kind, user, expiresIn] = String(credential.token).split(":");
	if (kind == "forbidden") {
		throw new VcmpError({title: "Forbidden", status: 403, detail: "Not allowed."});
	}
	if (kind != "valid") {
		throw new VcmpError({title: "Invalid token", status: 401, detail: "The token is invalid."});
	}
	return {
		principal: {user},
		expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn)) : undefined,
		ack: {user},
	};
}

interface Harness {
	server: VcmpServer<Principal>;
	url: string;
	events: string[];
	stop(): Promise<void>;
}

async function startServer(
	authentication?: Partial<VcmpServerAuthentication<Principal>>,
	options?: VcmpServerOptions<Principal>,
): Promise<Harness> {
	const webSocketServer = new WebSocketServer({port: 0});
	await new Promise<void>(resolve => webSocketServer.on("listening", () => resolve()));
	const server = new VcmpServer<Principal>({
		webSocketServer,
		authentication: authentication
			? {authenticate: tokenAuthenticator, ...authentication}
			: undefined,
		...options,
	});
	const events: string[] = [];
	server.onSessionConnected = session => events.push(`connected:${session.principal?.user}`);
	server.onSessionDisconnected = session => events.push(`disconnected:${session.principal?.user}`);
	server.on("echo", message => message);
	const port = (webSocketServer.address() as AddressInfo).port;
	const peers: RawPeer[] = [];
	return {
		server,
		url: `ws://localhost:${port}`,
		events,
		stop: async () => {
			peers.forEach(peer => peer.close());
			await server.stop();
		},
	};
}

function sleep(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(5);
	}
}

describe("VcmpServer authentication", function() {
	this.timeout(10000);

	let harness: Harness | undefined;
	const peers: RawPeer[] = [];

	async function connect(url = harness!.url) {
		const peer = await RawPeer.connect(url);
		peers.push(peer);
		return peer;
	}

	afterEach(async () => {
		peers.splice(0).forEach(peer => peer.close());
		await harness?.stop();
		harness = undefined;
	});

	describe("contract cases", () => {
		it("1: valid AUT is acknowledged, then messages flow both ways", async () => {
			harness = await startServer({});
			const peer = await connect();
			expect(harness.events).to.deep.equal([]);
			peer.aut("auth00000001", {token: "valid:alice"});
			const ack = await peer.expectFrame("ACKauth00000001");
			expect(JSON.parse(ack)).to.deep.equal({user: "alice"});
			await waitFor(() => harness!.events.length == 1);
			expect(harness.events).to.deep.equal(["connected:alice"]);
			expect(harness.server.sessions).to.have.length(1);
			expect(harness.server.sessions[0].principal).to.deep.equal({user: "alice"});

			// client → server
			peer.msg("msg000000001", {"@type": "echo", value: 1});
			expect(JSON.parse(await peer.expectFrame("ACKmsg000000001"))).to.deep.equal({"@type": "echo", value: 1});
			// server → client
			const sent = harness.server.sessions[0].send({"@type": "hello"});
			const msg = (peer.frames.find(f => f.startsWith("MSG")) ?? (await waitForMsg(peer)));
			peer.send(`ACK${msg.slice(3, 15)}"ok"`);
			expect(await sent).to.equal("ok");
		});

		it("2: invalid AUT is answered with NAK 401 and closes with 1008", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "nope"});
			const nak = JSON.parse(await peer.expectFrame("NAKauth00000001"));
			expect(nak.status).to.equal(401);
			const close = await peer.expectClose();
			expect(close).to.deep.equal({code: 1008, reason: "authentication failed"});
			expect(harness.events).to.deep.equal([]);
		});

		for (const frame of ["MSGmsg000000001{\"@type\":\"echo\"}", "ACKmsg000000001", "NAKmsg000000001"]) {
			it(`3: ${frame.slice(0, 3)} before AUT closes with 1008`, async () => {
				let handled = 0;
				harness = await startServer({});
				harness.server.on("echo", () => handled++);
				const peer = await connect();
				peer.send(frame);
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication required"});
				expect(peer.hasFrame("ACK")).to.be.false;
				expect(handled).to.equal(0);
				expect(harness.events).to.deep.equal([]);
			});
		}

		it("3: MSG while the first AUT is pending closes with 1008 and is not dispatched", async () => {
			let handled = 0;
			harness = await startServer({authenticate: () => new Promise(() => {})});
			harness.server.on("echo", () => handled++);
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			peer.msg("msg000000001", {"@type": "echo"});
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication required"});
			expect(handled).to.equal(0);
		});

		it("4: no AUT within the timeout closes with 1008", async () => {
			harness = await startServer({timeout: 100});
			const peer = await connect();
			const start = Date.now();
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication timeout"});
			expect(Date.now() - start).to.be.within(80, 600);
		});

		it("4: an AUT still pending at the timeout closes with 1008", async () => {
			harness = await startServer({timeout: 100, authenticate: () => new Promise(() => {})});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication timeout"});
			expect(harness.events).to.deep.equal([]);
		});

		it("4: heartbeats don't authenticate a session", async () => {
			// the server's watchdog (2 x interval) outlasts the authentication timeout
			harness = await startServer({timeout: 100}, {heartbeatInterval: 60});
			const peer = await connect();
			await peer.expectFrame("HBT");
			peer.send("HBT60");
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication timeout"});
		});

		it("5: AUT on an endpoint without authentication is answered with NAK 400, the session stays", async () => {
			harness = await startServer();
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			const nak = JSON.parse(await peer.expectFrame("NAKauth00000001"));
			expect(nak.status).to.equal(400);
			peer.msg("msg000000001", {"@type": "echo"});
			await peer.expectFrame("ACKmsg000000001");
			await peer.expectOpenFor(50);
			expect(harness.events).to.deep.equal(["connected:undefined"]);
		});

		it("6: the session closes with 1008 when expiresIn runs out", async () => {
			harness = await startServer({});
			const peer = await connect();
			const start = Date.now();
			peer.aut("auth00000001", {token: "valid:alice:200"});
			const ack = JSON.parse(await peer.expectFrame("ACKauth00000001"));
			expect(ack.expiresIn).to.be.within(150, 200);
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
			expect(Date.now() - start).to.be.within(180, 600);
			await waitFor(() => harness!.events.length == 2);
			expect(harness.events).to.deep.equal(["connected:alice", "disconnected:alice"]);
		});

		it("7: a refresh with the same principal moves the expiry, the session survives the old one", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice:200"});
			await peer.expectFrame("ACKauth00000001");
			await sleep(100);
			peer.aut("auth00000002", {token: "valid:alice:400"});
			const ack = JSON.parse(await peer.expectFrame("ACKauth00000002"));
			expect(ack.expiresIn).to.be.within(350, 400);
			// past the old expiry
			await peer.expectOpenFor(250);
			peer.msg("msg000000001", {"@type": "echo"});
			await peer.expectFrame("ACKmsg000000001");
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
			await waitFor(() => harness!.events.length == 2);
			expect(harness.events).to.deep.equal(["connected:alice", "disconnected:alice"]);
		});

		it("6: an expiry beyond setTimeout's range doesn't close the session early", async () => {
			const thirtyDays = 30 * 24 * 3600 * 1000;
			harness = await startServer({
				authenticate: () => ({principal: {user: "alice"}, expiresAt: new Date(Date.now() + thirtyDays)}),
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "x"});
			expect(JSON.parse(await peer.expectFrame("ACKauth00000001")).expiresIn).to.be.within(
				thirtyDays - 1000,
				thirtyDays,
			);
			await peer.expectOpenFor(50);
		});

		it("7: a refresh without expiry removes the expiry", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice:150"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "valid:alice"});
			expect(JSON.parse(await peer.expectFrame("ACKauth00000002"))).to.not.have.property("expiresIn");
			await peer.expectOpenFor(300);
		});

		it("8: a refresh with another principal is answered with NAK 403 and closes the session", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "valid:bob"});
			expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(403);
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "principal changed"});
			await waitFor(() => harness!.events.length == 2);
			// the session never changed identity
			expect(harness.events).to.deep.equal(["connected:alice", "disconnected:alice"]);
		});

		it("9: a failed refresh is answered with NAK 401, the session stays open until the old expiry", async () => {
			harness = await startServer({});
			const peer = await connect();
			const start = Date.now();
			peer.aut("auth00000001", {token: "valid:alice:300"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "expired"});
			expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(401);
			peer.msg("msg000000001", {"@type": "echo"});
			await peer.expectFrame("ACKmsg000000001");
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
			expect(Date.now() - start).to.be.within(280, 800);
		});

		describe("10: transition mode", () => {
			const handshake: Partial<VcmpServerAuthentication<Principal>> = {
				authenticateHandshake: request => {
					const token = new URL(request.url!, "http://localhost").searchParams.get("token");
					if (token == null) {
						return undefined;
					}
					if (!token.startsWith("legacy:")) {
						throw new Error("invalid handshake token");
					}
					return {principal: {user: token.slice(7)}};
				},
			};

			it("a valid handshake credential authenticates without AUT", async () => {
				harness = await startServer(handshake);
				const peer = await connect(`${harness.url}/?token=legacy:carol`);
				expect(harness.events).to.deep.equal(["connected:carol"]);
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				expect(harness.server.authenticationCounts).to.deep.equal({handshake: 1, aut: 0});
			});

			it("an invalid handshake credential closes with 1008, no fallback to AUT", async () => {
				harness = await startServer(handshake);
				const peer = await connect(`${harness.url}/?token=bogus`);
				peer.aut("auth00000001", {token: "valid:alice"});
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
				expect(peer.hasFrame("ACKauth00000001")).to.be.false;
				expect(harness.events).to.deep.equal([]);
			});

			it("no handshake credential requires AUT", async () => {
				harness = await startServer(handshake);
				const peer = await connect();
				peer.msg("msg000000001", {"@type": "echo"});
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication required"});

				const second = await connect();
				second.aut("auth00000001", {token: "valid:alice"});
				await second.expectFrame("ACKauth00000001");
				second.msg("msg000000001", {"@type": "echo"});
				await second.expectFrame("ACKmsg000000001");
				expect(harness.server.authenticationCounts).to.deep.equal({handshake: 0, aut: 1});
			});

			it("AUT after a handshake authentication is a re-authentication (same principal required)", async () => {
				harness = await startServer(handshake);
				const peer = await connect(`${harness.url}/?token=legacy:alice`);
				peer.aut("auth00000001", {token: "valid:alice:5000"});
				expect(JSON.parse(await peer.expectFrame("ACKauth00000001")).expiresIn).to.be.within(4900, 5000);
				peer.aut("auth00000002", {token: "valid:bob"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(403);
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "principal changed"});
				// connected once, by its handshake
				await waitFor(() => harness!.events.length == 2);
				expect(harness.events).to.deep.equal(["connected:alice", "disconnected:alice"]);
				expect(harness.server.authenticationCounts).to.deep.equal({handshake: 1, aut: 0});
			});

			it("holds frames while an asynchronous handshake authenticator runs", async () => {
				harness = await startServer({
					authenticateHandshake: async () => {
						await sleep(50);
						return {principal: {user: "dave"}};
					},
				});
				const peer = await connect();
				// an old client sends right away
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				expect(harness.events).to.deep.equal(["connected:dave"]);
			});

			it("a rejecting asynchronous handshake authenticator closes with 1008", async () => {
				let handled = 0;
				harness = await startServer({
					authenticateHandshake: async () => {
						await sleep(20);
						throw new Error("invalid");
					},
				});
				harness.server.on("echo", () => handled++);
				const peer = await connect();
				peer.msg("msg000000001", {"@type": "echo"});
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
				expect(handled).to.equal(0);
			});

			it("a handshake expiry closes the session", async () => {
				harness = await startServer({
					authenticateHandshake: () => ({principal: {user: "eve"}, expiresAt: new Date(Date.now() + 100)}),
				});
				const peer = await connect();
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
			});
		});
	});

	describe("server rules", () => {
		it("closes the session on a second AUT while one is pending", async () => {
			harness = await startServer({
				authenticate: async credential => {
					await sleep(100);
					return tokenAuthenticator(credential);
				},
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			peer.aut("auth00000002", {token: "valid:alice"});
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "concurrent authentication"});
			await sleep(150);
			expect(peer.hasFrame("ACK")).to.be.false;
			expect(harness.events).to.deep.equal([]);
		});

		it("closes the session on a second AUT while a re-authentication is pending", async () => {
			let calls = 0;
			harness = await startServer({
				authenticate: async credential => {
					if (calls++ > 0) {
						await sleep(100);
					}
					return tokenAuthenticator(credential);
				},
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "valid:alice"});
			peer.aut("auth00000003", {token: "valid:alice"});
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "concurrent authentication"});
		});

		it("answers a first AUT whose payload is not a JSON object with NAK 400 and closes", async () => {
			for (const payload of ["[1]", "\"token\"", "{oops", ""]) {
				harness = await startServer({});
				const peer = await connect();
				peer.aut("auth00000001", payload);
				expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(400);
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
				await harness.stop();
				harness = undefined;
			}
		});

		it("answers a re-authentication whose payload is not a JSON object with NAK 400, the session stays", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", "[1]");
			expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(400);
			await peer.expectOpenFor(50);
		});

		it("answers a rejection with 403 when the authenticator says so", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "forbidden"});
			expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(403);
			expect((await peer.expectClose()).code).to.equal(1008);
		});

		it("answers an unexpected authenticator failure with NAK 500 without leaking its message, and closes", async () => {
			harness = await startServer({
				authenticate: () => {
					throw new Error("database password is hunter2");
				},
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			const nak = await peer.expectFrame("NAKauth00000001");
			expect(JSON.parse(nak).status).to.equal(500);
			expect(nak).to.not.contain("hunter2");
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
			expect(harness.events).to.deep.equal([]);
		});

		it("answers an unexpected failure on re-authentication with NAK 500, the session stays until the old expiry", async () => {
			let calls = 0;
			harness = await startServer({
				authenticate: async credential => {
					if (calls++ > 0) {
						throw new Error("database down");
					}
					return tokenAuthenticator(credential);
				},
			});
			const peer = await connect();
			const start = Date.now();
			peer.aut("auth00000001", {token: "valid:alice:300"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "valid:alice:300"});
			expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(500);
			peer.msg("msg000000001", {"@type": "echo"});
			await peer.expectFrame("ACKmsg000000001");
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
			expect(Date.now() - start).to.be.within(280, 800);
		});

		it("keeps the session until the old expiry when a re-authentication is rejected with 403", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice:300"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "forbidden"});
			expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(403);
			await peer.expectOpenFor(100);
			expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
		});

		describe("fails closed after the authenticator accepted", () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);

			beforeEach(() => {
				unhandled.length = 0;
				process.on("unhandledRejection", onUnhandled);
			});

			afterEach(() => {
				process.off("unhandledRejection", onUnhandled);
			});

			const circular: Record<string, unknown> = {};
			circular.self = circular;
			for (
				const [name, ack] of [
					["a BigInt", {n: BigInt(1)}],
					["a circular structure", {entity: circular}],
				] as const
			) {
				it(`answers a first AUT whose ACK payload contains ${name} with NAK 500 and closes`, async () => {
					let handled = 0;
					harness = await startServer({authenticate: () => ({principal: {user: "alice"}, ack})});
					harness.server.on("echo", () => handled++);
					const peer = await connect();
					peer.aut("auth00000001", {token: "x"});
					expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(500);
					peer.msg("msg000000001", {"@type": "echo"});
					expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
					await sleep(20);
					expect(handled).to.equal(0);
					expect(harness.events).to.deep.equal([]);
					expect(harness.server.authenticationCounts).to.deep.equal({handshake: 0, aut: 0});
					expect(unhandled).to.deep.equal([]);
				});
			}

			it("answers a refresh whose ACK payload can't be serialized with NAK 500, keeping the old expiry", async () => {
				let calls = 0;
				harness = await startServer({
					authenticate: credential => {
						const authentication = tokenAuthenticator(credential);
						return calls++ == 0 ? authentication : {...authentication, ack: {n: BigInt(1)}};
					},
				});
				const peer = await connect();
				peer.aut("auth00000001", {token: "valid:alice:300"});
				await peer.expectFrame("ACKauth00000001");
				// would move the expiry far out, if it were committed
				peer.aut("auth00000002", {token: "valid:alice:5000"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(500);
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
				expect(unhandled).to.deep.equal([]);
			});

			it("answers a refresh whose principal comparison throws with NAK 500, keeping the session until the old expiry", async () => {
				harness = await startServer({
					principalEquals: () => {
						throw new Error("cannot compare");
					},
				});
				const peer = await connect();
				peer.aut("auth00000001", {token: "valid:alice:300"});
				await peer.expectFrame("ACKauth00000001");
				peer.aut("auth00000002", {token: "valid:alice:5000"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(500);
				await peer.expectOpenFor(100);
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
				await waitFor(() => harness!.events.length == 2);
				expect(harness.events).to.deep.equal(["connected:alice", "disconnected:alice"]);
				expect(unhandled).to.deep.equal([]);
			});

			for (const principal of [undefined, null]) {
				it(`answers an authentication with principal ${principal} with NAK 500 and closes`, async () => {
					let handled = 0;
					harness = await startServer({authenticate: () => ({principal: principal as any})});
					harness.server.on("echo", () => handled++);
					const peer = await connect();
					peer.aut("auth00000001", {token: "unknown"});
					expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(500);
					expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
					expect(harness.events).to.deep.equal([]);
					expect(handled).to.equal(0);
				});

				it(`closes a session whose handshake authentication has principal ${principal}`, async () => {
					harness = await startServer({authenticateHandshake: () => ({principal: principal as any})});
					const peer = await connect();
					expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
					expect(harness.events).to.deep.equal([]);
				});
			}
		});

		it("logs an authenticator's exception by type and message, never the AUT payload", async () => {
			const logged: string[] = [];
			const collect = (...data: any[]) => logged.push(data.map(item => JSON.stringify(item)).join(" "));
			harness = await startServer({
				authenticate: () => {
					throw new TypeError("token lookup failed");
				},
			}, {debug: {info: collect, debug: collect, warn: collect, error: collect}});
			const peer = await connect();
			peer.aut("auth00000001", "{\"token\":\"s3cr3t\""); // not valid JSON: the parse error must not be logged
			await peer.expectFrame("NAKauth00000001");
			const second = await connect();
			second.aut("auth00000002", {token: "s3cr3t"});
			await second.expectFrame("NAKauth00000002");
			expect(logged.join("\n")).to.contain("TypeError: token lookup failed");
			expect(logged.join("\n")).to.not.contain("s3cr3t");
		});

		describe("an expiry that is already over", () => {
			it("rejects a first AUT with NAK 401 and closes", async () => {
				harness = await startServer({
					authenticate: () => ({principal: {user: "alice"}, expiresAt: new Date(Date.now() - 1)}),
				});
				const peer = await connect();
				peer.aut("auth00000001", {token: "x"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(401);
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
				expect(harness.events).to.deep.equal([]);
			});

			it("rejects an expiry of exactly now", async () => {
				harness = await startServer({
					authenticate: () => ({principal: {user: "alice"}, expiresAt: new Date()}),
				});
				const peer = await connect();
				peer.aut("auth00000001", {token: "x"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000001")).status).to.equal(401);
				expect((await peer.expectClose()).code).to.equal(1008);
			});

			it("decides on one expiresIn: never acknowledges with expiresIn 0 when the clock moves on", async () => {
				// The clock advances 1 ms on every read, starting 1 ms before the expiry: a library that checks the
				// expiry and computes expiresIn with two reads would acknowledge with expiresIn 0.
				const realNow = Date.now;
				let restore = () => {};
				harness = await startServer({
					authenticate: () => {
						const expiresAt = realNow() + 60000;
						let now = expiresAt - 1;
						Date.now = () => now++;
						restore = () => Date.now = realNow;
						return {principal: {user: "alice"}, expiresAt: new Date(expiresAt)};
					},
				});
				try {
					const peer = await connect();
					peer.aut("auth00000001", {token: "x"});
					const ack = JSON.parse(await peer.expectFrame("ACKauth00000001"));
					expect(ack.expiresIn).to.equal(1);
				}
				finally {
					restore();
				}
			});

			it("rejects a refresh with NAK 401, the session stays until the old expiry", async () => {
				let calls = 0;
				harness = await startServer({
					authenticate: () => ({
						principal: {user: "alice"},
						expiresAt: new Date(Date.now() + (calls++ == 0 ? 300 : -1)),
					}),
				});
				const peer = await connect();
				const start = Date.now();
				peer.aut("auth00000001", {token: "x"});
				await peer.expectFrame("ACKauth00000001");
				peer.aut("auth00000002", {token: "x"});
				expect(JSON.parse(await peer.expectFrame("NAKauth00000002")).status).to.equal(401);
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication expired"});
				expect(Date.now() - start).to.be.within(280, 800);
			});

			it("closes a session whose handshake authentication has expired", async () => {
				harness = await startServer({
					authenticateHandshake: () => ({principal: {user: "old"}, expiresAt: new Date(Date.now() - 1)}),
				});
				const peer = await connect();
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication failed"});
				expect(harness.events).to.deep.equal([]);
				expect(harness.server.authenticationCounts).to.deep.equal({handshake: 0, aut: 0});
			});
		});

		describe("unparseable frames", () => {
			for (const [name, frame] of [["an unknown frame type", "XYZgarbage"], ["an empty frame", ""]] as const) {
				it(`closes on ${name} before authentication`, async () => {
					harness = await startServer({});
					const peer = await connect();
					peer.send(frame);
					expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication required"});
				});
			}

			it("closes on a binary frame before authentication", async () => {
				harness = await startServer({});
				const peer = await connect();
				peer.webSocket.send(Buffer.from("MSGmsg000000001{}"));
				expect(await peer.expectClose()).to.deep.equal({code: 1008, reason: "authentication required"});
			});

			it("drops and logs an unparseable frame after authentication", async () => {
				harness = await startServer({});
				const peer = await connect();
				peer.aut("auth00000001", {token: "valid:alice"});
				await peer.expectFrame("ACKauth00000001");
				peer.send("XYZgarbage");
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				await peer.expectOpenFor(50);
			});

			it("drops and logs an unparseable frame on an endpoint without authentication", async () => {
				harness = await startServer();
				const peer = await connect();
				peer.send("XYZgarbage");
				peer.msg("msg000000001", {"@type": "echo"});
				await peer.expectFrame("ACKmsg000000001");
				await peer.expectOpenFor(50);
			});
		});

		it("reserves expiresIn in the ACK payload", async () => {
			harness = await startServer({
				authenticate: () => ({principal: {user: "alice"}, ack: {expiresIn: 1, role: "admin"}}),
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "x"});
			expect(JSON.parse(await peer.expectFrame("ACKauth00000001"))).to.deep.equal({role: "admin"});
		});

		it("sends an ACK without payload when there is nothing to report", async () => {
			harness = await startServer({authenticate: () => ({principal: {user: "alice"}})});
			const peer = await connect();
			peer.aut("auth00000001", {token: "x"});
			expect(await peer.expectFrame("ACKauth00000001")).to.equal("");
		});

		it("passes the session to the authenticator and refuses sends on it before authentication", async () => {
			let sendError: unknown;
			harness = await startServer({
				authenticate: async (credential, session) => {
					sendError = await session.send({"@type": "early"}).catch(error => error);
					return tokenAuthenticator(credential);
				},
			});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			await peer.expectFrame("ACKauth00000001");
			expect(sendError).to.be.instanceOf(VcmpError);
			expect((sendError as VcmpError).status).to.equal(503);
			expect(peer.hasFrame("MSG")).to.be.false;
		});

		it("never broadcasts to an unauthenticated session", async () => {
			harness = await startServer({});
			const authenticated = await connect();
			const unauthenticated = await connect();
			authenticated.aut("auth00000001", {token: "valid:alice"});
			await authenticated.expectFrame("ACKauth00000001");
			const broadcast = harness.server.broadcast({"@type": "news"});
			const msg = await waitForMsg(authenticated);
			authenticated.send(`ACK${msg.slice(3, 15)}`);
			const results = await broadcast;
			expect(results).to.have.length(1);
			expect(results[0].session.principal).to.deep.equal({user: "alice"});
			await sleep(20);
			expect(unauthenticated.hasFrame("MSG")).to.be.false;
		});

		it("reports disconnect only for sessions that were connected", async () => {
			harness = await startServer({});
			const peer = await connect();
			peer.close();
			await peer.closed;
			await sleep(20);
			expect(harness.events).to.deep.equal([]);
		});

		it("counts sessions authenticated by handshake and by AUT", async () => {
			const logged: string[] = [];
			const debug = {
				info: (...data: any[]) => logged.push(data.join(" ")),
				debug: () => {},
				warn: () => {},
				error: () => {},
			};
			harness = await startServer({
				authenticateHandshake: request =>
					request.url?.includes("legacy") ? {principal: {user: "old"}} : undefined,
			}, {debug});
			await connect(`${harness.url}/?legacy`);
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice"});
			await peer.expectFrame("ACKauth00000001");
			expect(harness.server.authenticationCounts).to.deep.equal({handshake: 1, aut: 1});
			expect(logged.filter(line => line.startsWith("Session authenticated"))).to.have.length(2);
		});

		it("never writes the credential to debug output", async () => {
			const logged: string[] = [];
			const collect = (...data: any[]) => logged.push(data.map(item => JSON.stringify(item)).join(" "));
			harness = await startServer({}, {debug: {info: collect, debug: collect, warn: collect, error: collect}});
			const peer = await connect();
			peer.aut("auth00000001", {token: "valid:alice", password: "s3cr3t-first"});
			await peer.expectFrame("ACKauth00000001");
			peer.aut("auth00000002", {token: "s3cr3t-invalid"});
			await peer.expectFrame("NAKauth00000002");
			expect(logged.join("\n")).to.contain("AUTauth00000001");
			expect(logged.join("\n")).to.not.contain("s3cr3t");
		});

		it("closes unauthenticated sessions on stop", async () => {
			harness = await startServer({});
			const peer = await connect();
			const stopped = harness.server.stop();
			await peer.expectClose();
			await stopped;
			harness = undefined;
		});
	});

	describe("with VcmpClient", () => {
		it("authenticates, refreshes before the expiry and exchanges messages", async () => {
			const credentials: string[] = [];
			harness = await startServer({});
			harness.server.on("whoami", (message, session) => (session as VcmpSession<Principal>).principal?.user);
			const client = new VcmpClient(harness.url, {
				customWebSocket: NodeWebSocket,
				authenticate: async () => {
					credentials.push("valid:alice:1500");
					return {token: "valid:alice:1500"};
				},
				refreshLeadTime: 100,
			});
			const acks: unknown[] = [];
			client.onAuthenticated = ack => acks.push(ack);
			const opened = new Promise<void>(resolve => client.onOpen = () => resolve());
			client.start();
			await opened;
			expect(client.connected).to.be.true;
			expect(client.authentication).to.include({user: "alice"});
			expect(await client.send({"@type": "whoami"})).to.equal("alice");
			// survives several expiries thanks to the refresh
			await sleep(3200);
			expect(client.connected).to.be.true;
			expect(await client.send({"@type": "whoami"})).to.equal("alice");
			expect(credentials.length).to.be.at.least(3);
			expect(acks.length).to.equal(credentials.length);
			expect(harness.events).to.deep.equal(["connected:alice"]);
			client.stop();
		});

		it("11: a client with authenticate against an endpoint without the opt-in reports NAK 400 and never sends MSG", async () => {
			let handled = 0;
			harness = await startServer();
			harness.server.on("foo", () => handled++);
			let pending: Promise<unknown> | undefined;
			const client: VcmpClient = new VcmpClient(harness.url, {
				customWebSocket: NodeWebSocket,
				authenticate: async () => {
					// the socket is open, the authentication not yet acknowledged: the message is held back
					pending = client.send({"@type": "foo"}).then(() => "sent", error => error);
					return {token: "x"};
				},
				reconnectTimeout: 10000,
			});
			let opened = false;
			client.onOpen = () => opened = true;
			const errors: VcmpError[] = [];
			const closed = new Promise<void>(resolve => client.onClose = () => resolve());
			client.onAuthenticationError = error => errors.push(error);
			client.start();
			await closed;
			expect(errors.map(error => error.status)).to.deep.equal([400]);
			expect(((await pending) as VcmpError).status).to.equal(503);
			expect(opened).to.be.false;
			expect(handled).to.equal(0);
			client.stop();
		});
	});
});

async function waitForMsg(peer: RawPeer) {
	await waitFor(() => peer.hasFrame("MSG"));
	const frame = peer.frames.find(frame => frame.startsWith("MSG"))!;
	peer.frames.splice(peer.frames.indexOf(frame), 1);
	return frame;
}
