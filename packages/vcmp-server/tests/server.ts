import {isProblemDetail, VcmpClient, VcmpError} from "@variocube/vcmp";
import {expect} from "chai";
import NodeWebSocket from "ws";
import {VcmpServer} from "../src";

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
		client1.on("foo", () => {
			messageCount++;
		});
		client2.on("foo", () => {
			messageCount++;
		});

		const results = await server.broadcast({
			"@type": "foo",
			foo: "bar",
		});

		expect(results).to.have.length(2);
		expect(results.filter(entry => entry.error)).to.have.length(0);
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
		};
		const client = createClient("ws://localhost:12345");
		let messageCount = 0;
		client.on("foo", () => {
			messageCount++;
		});
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
		server.on("foo", () => {
			messageCount++;
		});

		const client = await createConnectedClient("ws://localhost:12345");
		await client.send({"@type": "foo"});

		client.stop();
		await server.stop();

		expect(messageCount).to.be.equal(1);
	});

	it("can return result", async () => {
		const server = new VcmpServer({
			port: 12345,
			debug: console,
		});
		server.on("foo", () => "bar");
		const client = await createConnectedClient("ws://localhost:12345");
		const result = await client.send({"@type": "foo"});
		expect(result).to.be.equal("bar");
		client.stop();
		await server.stop();
	});

	it("can return error", async () => {
		const server = new VcmpServer({
			port: 12345,
			debug: console,
		});
		server.on("foo", () => {
			throw new Error("bar");
		});
		const client = await createConnectedClient("ws://localhost:12345");
		try {
			await client.send({"@type": "foo"});
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of Error");
			expect(error.message).to.be.equal("bar");
			expect(error.status).to.be.equal(500);
			expect(error.detail).to.be.equal("bar");
		}
		finally {
			client.stop();
			await server.stop();
		}
	});

	it("can return problem detail", async () => {
		const server = new VcmpServer({
			port: 12345,
			debug: console,
		});
		server.on("foo", () => {
			throw new VcmpError({
				title: "bar",
				status: 400,
				detail: "baz",
				type: "https://example.com/errors/invalid-request",
				instance: "https://example.com/account/51dceb58-37be-4bf9-9340-019dc4f9c08c",
				foo: "bar",
			});
		});
		const client = await createConnectedClient("ws://localhost:12345");
		try {
			await client.send({"@type": "foo"});
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of Error");
			expect(isProblemDetail(error)).to.be.true;
			expect(error.title).to.be.equal("bar");
			expect(error.status).to.be.equal(400);
			expect(error.detail).to.be.equal("baz");
			expect(error.type).to.be.equal("https://example.com/errors/invalid-request");
			expect(error.instance).to.be.equal("https://example.com/account/51dceb58-37be-4bf9-9340-019dc4f9c08c");
			expect(error.foo).to.be.equal("bar");
		}
		finally {
			client.stop();
			await server.stop();
		}
	});

	it("rejects pending sends when the session closes before ack", async () => {
		const server = new VcmpServer({
			port: 12345,
		});
		// a handler that never settles, so the ACK is never sent
		server.on("foo", () => new Promise(() => {}));
		const client = await createConnectedClient("ws://localhost:12345");
		const pending = client.send({"@type": "foo"});
		// let the message reach the server, then close the session underneath the client
		await sleep(20);
		server.sessions.forEach(session => session.close());
		try {
			await pending;
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(503);
			expect(error.title).to.be.equal("Session closed");
		}
		finally {
			client.stop();
			await server.stop();
		}
	});

	it("rejects sends on a session that is not open", async () => {
		const server = new VcmpServer({
			port: 12345,
		});
		const client = await createConnectedClient("ws://localhost:12345");
		const session = server.sessions[0];
		// wait for the close to actually propagate to the server side
		const disconnected = new Promise<void>(resolve => server.onSessionDisconnected = () => resolve());
		client.stop();
		await disconnected;
		try {
			await session.send({"@type": "foo"});
			expect.fail("Expected error");
		}
		catch (error) {
			if (!(error instanceof VcmpError)) throw new Error("Expected error to be instance of VcmpError");
			expect(error.status).to.be.equal(503);
			expect(error.title).to.be.equal("Session not open");
		}
		finally {
			await server.stop();
		}
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
		debug: console,
		customWebSocket: NodeWebSocket,
	});
}

function awaitConnected(client: VcmpClient) {
	return new Promise<void>((resolve) => {
		client.onOpen = () => resolve();
	});
}

function sleep(timeoutMs: number) {
	return new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
}
