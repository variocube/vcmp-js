import NodeWebSocket, {MessageEvent} from "ws";
import {asyncExecute} from "./asyncExecute";
import {createVcmpError, VcmpError} from "./error";
import {generateVcmpFrameId, parseVcmpFrame, serializeVcmpFrame, VcmpFrame, VcmpHeartbeatFrame} from "./frame";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";

type PromiseCallbacks = {
	resolve: (result?: any) => void;
	reject: (reason?: any) => void;
};

interface VcmpSessionOptions {
	webSocket: WebSocket | NodeWebSocket;
	resolver: (type: string) => VcmpHandler<any> | undefined;
	debug?: ConsoleLike;
}

export class VcmpSession {
	constructor({webSocket, resolver, debug}: VcmpSessionOptions) {
		webSocket.onmessage = this.handleMessage;
		webSocket.onerror = this.handleError;
		webSocket.onopen = this.handleOpen;
		webSocket.onclose = this.handleClose;

		this.webSocket = webSocket;
		this.resolver = resolver;
		this.debug = debug;
	}

	private readonly webSocket: WebSocket | NodeWebSocket;
	private readonly resolver: (type: string) => VcmpHandler<any> | undefined;
	private readonly debug?: ConsoleLike;

	public onOpen?: OpenHandler;
	public onClose?: CloseHandler;

	private heartbeatTimeout?: number | NodeJS.Timeout;
	private heartbeatReceiveTimeout?: number | NodeJS.Timeout;
	private awaitingHeartbeat = true;

	private callbacks = new Map<string, PromiseCallbacks>();

	send<T extends VcmpMessage>(message: T) {
		this.debug?.debug("Sending VcmpMessage", message);
		return new Promise<any>((resolve, reject) => {
			if (!this.isOpen) {
				reject(
					new VcmpError({
						title: "Session not open",
						status: 503,
						detail: "Cannot send message: the WebSocket is not open.",
					}),
				);
				return;
			}
			const payload = JSON.stringify(message);
			const id = generateVcmpFrameId();
			// Register before sending: a synchronously-delivering WebSocket (in-memory pairs,
			// test doubles passed via customWebSocket) can deliver the ACK during sendFrame.
			this.callbacks.set(id, {resolve, reject});
			try {
				this.sendFrame({type: "MSG", id, payload});
			}
			catch (error) {
				this.callbacks.delete(id);
				throw error;
			}
		});
	}

	close() {
		this.webSocket.close();
	}

	get isOpen() {
		return this.webSocket.readyState == 1; // 1...OPEN
	}

	initiateHeartbeat(heartbeatInterval: number) {
		this.sendHeartbeat({type: "HBT", heartbeatInterval});
	}

	private handleAck(frameId: string, payload: string | undefined) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			try {
				const result = payload ? JSON.parse(payload) : undefined;
				promise.resolve(result);
			}
			catch (error) {
				this.debug?.warn("Could not parse ACK payload", payload, error);
				promise.reject(
					new VcmpError({
						title: "Invalid acknowledgement",
						status: 500,
						detail: "The ACK payload could not be parsed.",
						cause: error,
					}),
				);
			}
		}
	}

	private handleNak(frameId: string, payload: string | undefined) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			let error: VcmpError;
			try {
				error = payload ? createVcmpError(JSON.parse(payload)) : new VcmpError({
					title: "Message handling failed",
					status: 500,
					detail: "Unspecified error in message handling.",
				});
			}
			catch (parseError) {
				this.debug?.warn("Could not parse NAK payload", payload, parseError);
				error = new VcmpError({
					title: "Message handling failed",
					status: 500,
					detail: "The NAK payload could not be parsed.",
					cause: parseError,
				});
			}
			promise.reject(error);
		}
	}

	/**
	 * Removes and returns the promise callbacks of a pending message.
	 * Returns undefined if the message is not pending (already settled or unknown).
	 */
	private takePendingMessage(frameId: string) {
		const promise = this.callbacks.get(frameId);
		if (promise) {
			this.callbacks.delete(frameId);
		}
		return promise;
	}

	private failPendingMessage(frameId: string, error: VcmpError) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			this.debug?.warn("Failing pending message", frameId, error.detail);
			promise.reject(error);
		}
	}

	private failAllPendingMessages(error: VcmpError) {
		for (const frameId of [...this.callbacks.keys()]) {
			this.failPendingMessage(frameId, error);
		}
	}

	private sendFrame(frame: VcmpFrame) {
		if (this.webSocket) {
			const serializedFrame = serializeVcmpFrame(frame);
			this.debug?.debug("Sending frame", serializedFrame);
			this.webSocket.send(serializedFrame);
		}
	}

	/**
	 * Sends a frame on a best-effort basis from the inbound message path,
	 * where a send failure must not propagate into the WebSocket's message event.
	 */
	private trySendFrame(frame: VcmpFrame) {
		try {
			this.sendFrame(frame);
		}
		catch (error) {
			this.debug?.warn("Could not send frame", frame.type, error);
		}
	}

	private handleOpen = () => {
		this.debug?.debug("WebSocket session open");
		this.awaitingHeartbeat = true;
		this.onOpen && this.onOpen();
	};

	private handleClose = (event: CloseEvent | NodeWebSocket.CloseEvent) => {
		this.debug?.debug("WebSocket session closed", {
			type: event.type,
			code: event.code,
			reason: event.reason,
		});
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout as any);
		}
		if (this.heartbeatReceiveTimeout) {
			clearTimeout(this.heartbeatReceiveTimeout as any);
		}
		this.failAllPendingMessages(
			new VcmpError({
				title: "Session closed",
				status: 503,
				detail: "The session was closed before the message was acknowledged.",
			}),
		);
		this.onClose && this.onClose();
	};

	private handleError = () => {
		this.debug?.warn("WebSocket session error");
		if (this.webSocket) {
			this.webSocket.close();
		}
	};

	private handleMessage = (event: MessageEvent | NodeWebSocket.MessageEvent) => {
		if (typeof event.data == "string") {
			this.debug?.debug("Received frame", event.data);
			let frame: ReturnType<typeof parseVcmpFrame>;
			try {
				frame = parseVcmpFrame(event.data);
			}
			catch (error) {
				// A throw from the message event would be an uncaught exception under Node's
				// `ws` and could take the whole process down. Log and drop the frame instead.
				this.debug?.warn("Ignoring invalid frame", event.data, error);
				return;
			}
			this.debug?.debug("Parsed frame", frame);
			switch (frame.type) {
				case "HBT":
					this.handleHeartbeatReceived(frame);
					break;

				case "ACK":
					this.handleAck(frame.id, frame.payload);
					break;

				case "NAK":
					this.handleNak(frame.id, frame.payload);
					break;

				case "MSG":
					this.handleVcmpMessage(frame.id, frame.payload);
					break;
			}
		}
	};

	private sendHeartbeat(frame: VcmpHeartbeatFrame) {
		this.debug?.debug("Sending heartbeat.");

		// set the flag that we await a heartbeat
		this.awaitingHeartbeat = true;

		// Arm the watchdog before sending: if the peer never sends a heartbeat back
		// within 2 x interval, the connection is considered dead and closed. This also
		// covers a peer that connects but never answers the initial heartbeat at all.
		clearTimeout(this.heartbeatReceiveTimeout as any);
		this.heartbeatReceiveTimeout = setTimeout(() => {
			this.debug?.warn("Did not receive heartbeat in time. Closing session.");
			this.close();
		}, 2 * frame.heartbeatInterval);

		this.trySendFrame(frame);
	}

	private handleHeartbeatReceived(frame: VcmpHeartbeatFrame) {
		// check whether we are currently awaiting a heartbeat
		if (this.awaitingHeartbeat) {
			// clear the flag that we are awaiting a heartbeat
			this.awaitingHeartbeat = false;

			this.debug?.debug("Received heartbeat.");

			// clear the heartbeat receive timeout
			clearTimeout(this.heartbeatReceiveTimeout as any);

			// send heartbeat after the interval passes
			this.heartbeatTimeout = setTimeout(() => this.sendHeartbeat(frame), frame.heartbeatInterval);
		}
		else {
			this.debug?.warn("Ignoring unexpected heartbeat.");
		}
	}

	private handleVcmpMessage(frameId: string, payload: string | undefined) {
		let message: any;
		try {
			message = payload ? JSON.parse(payload) : {};
		}
		catch (error) {
			// NAK the frame so the peer's send() settles instead of pending forever.
			this.debug?.warn("Could not parse message payload, sending NAK", payload, error);
			this.trySendFrame({
				type: "NAK",
				id: frameId,
				payload: JSON.stringify(
					new VcmpError({
						title: "Invalid message",
						status: 400,
						detail: "The message payload could not be parsed.",
					}),
				),
			});
			return;
		}
		const type = message["@type"];
		if (type) {
			const handler = this.resolver(type);
			if (handler) {
				asyncExecute(async () => {
					try {
						const result = await handler(message, this);
						this.trySendFrame({
							type: "ACK",
							id: frameId,
							payload: result !== undefined ? JSON.stringify(result) : undefined,
						});
					}
					catch (error) {
						this.debug?.warn("Error in handler, sending NAK", error);
						this.trySendFrame({
							type: "NAK",
							id: frameId,
							payload: JSON.stringify(createVcmpError(error)),
						});
					}
				});
			}
			else {
				this.debug?.warn("No handler found for message, sending NAK", message);
				this.trySendFrame({type: "NAK", id: frameId});
			}
		}
		else {
			this.debug?.error("Could not determine type of message, sending NAK", message);
			this.trySendFrame({
				type: "NAK",
				id: frameId,
				payload: JSON.stringify(
					new VcmpError({
						title: "Invalid message",
						status: 400,
						detail: "The message does not specify a type.",
					}),
				),
			});
		}
	}
}
