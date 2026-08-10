import NodeWebSocket, {MessageEvent} from "ws";
import {asyncExecute} from "./asyncExecute";
import {createVcmpError, VcmpError} from "./error";
import {generateVcmpFrameId, parseVcmpFrame, serializeVcmpFrame, VcmpFrame, VcmpHeartbeatFrame} from "./frame";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";

type PromiseCallbacks = {
	resolve: (result?: any) => void;
	reject: (reason?: any) => void;
	timeout?: number | NodeJS.Timeout;
};

interface VcmpSessionOptions {
	webSocket: WebSocket | NodeWebSocket;
	resolver: (type: string) => VcmpHandler<any> | undefined;
	debug?: ConsoleLike;
	/**
	 * Optional timeout in milliseconds for awaiting the acknowledgement of a sent message.
	 * When it elapses, the promise returned from `send` rejects with a `VcmpError` (status 504).
	 * Disabled by default (or with a value of 0 or below): the promise then settles only on
	 * ACK/NAK or when the session closes — bounding the wait is the caller's decision.
	 */
	ackTimeout?: number;
}

export class VcmpSession {
	constructor({webSocket, resolver, debug, ackTimeout}: VcmpSessionOptions) {
		webSocket.onmessage = this.handleMessage;
		webSocket.onerror = this.handleError;
		webSocket.onopen = this.handleOpen;
		webSocket.onclose = this.handleClose;

		this.webSocket = webSocket;
		this.resolver = resolver;
		this.debug = debug;
		this.ackTimeout = ackTimeout ?? 0;
	}

	private readonly webSocket: WebSocket | NodeWebSocket;
	private readonly resolver: (type: string) => VcmpHandler<any> | undefined;
	private readonly debug?: ConsoleLike;
	private readonly ackTimeout: number;

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
			// Send before registering the callbacks entry: if sendFrame throws synchronously,
			// the executor rejects the promise and no entry or timer is left behind. The ACK
			// cannot overtake the registration, since it arrives on a later event-loop turn.
			this.sendFrame({type: "MSG", id, payload});
			const timeout = this.ackTimeout > 0
				? setTimeout(() =>
					this.failPendingMessage(
						id,
						new VcmpError({
							title: "Acknowledgement timeout",
							status: 504,
							detail: `The message was not acknowledged within ${this.ackTimeout} ms.`,
						}),
					), this.ackTimeout)
				: undefined;
			this.callbacks.set(id, {resolve, reject, timeout});
		});
	}

	close() {
		this.webSocket.close();
	}

	get isOpen() {
		return this.webSocket.readyState == 1; // 1...OPEN
	}

	initiateHeartbeat(heartbeatInterval: number) {
		this.sendFrame({type: "HBT", heartbeatInterval});
	}

	private handleAck(frameId: string, payload: string | undefined) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			try {
				const result = payload ? JSON.parse(payload) : undefined;
				promise.resolve(result);
			}
			catch (error) {
				promise.reject(
					new VcmpError({
						title: "Invalid acknowledgement",
						status: 500,
						detail: "The ACK payload could not be parsed.",
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
				error = new VcmpError({
					title: "Message handling failed",
					status: 500,
					detail: "The NAK payload could not be parsed.",
				});
			}
			promise.reject(error);
		}
	}

	/**
	 * Removes and returns the promise callbacks of a pending message, clearing its ack timeout.
	 * Returns undefined if the message is not pending (already settled or unknown).
	 */
	private takePendingMessage(frameId: string) {
		const promise = this.callbacks.get(frameId);
		if (promise) {
			this.callbacks.delete(frameId);
			if (promise.timeout) {
				clearTimeout(promise.timeout as any);
			}
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
			const frame = parseVcmpFrame(event.data);
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

	private handleHeartbeatReceived(frame: VcmpHeartbeatFrame) {
		// check whether we are currently awaiting a heartbeat
		if (this.awaitingHeartbeat) {
			// clear the flag that we are awaiting a heartbeat
			this.awaitingHeartbeat = false;

			this.debug?.debug("Received heartbeat.");

			// clear previous heartbeat receive timeout
			clearTimeout(this.heartbeatReceiveTimeout as any);

			// send heartbeat after the interval passes
			this.heartbeatTimeout = setTimeout(() => {
				this.debug?.debug("Sending heartbeat.");

				// send the heartbeat
				this.sendFrame(frame);

				// set the flag that we await a heartbeat
				this.awaitingHeartbeat = true;

				// set up a new heartbeat receive timeout, that closes the session
				// if we don't receive a heartbeat back within 2 x interval
				this.heartbeatReceiveTimeout = setTimeout(() => {
					this.debug?.warn("Did not receive heartbeat in time. Closing session.");
					this.close();
				}, 2 * frame.heartbeatInterval);
			}, frame.heartbeatInterval);
		}
		else {
			this.debug?.warn("Ignoring unexpected heartbeat.");
		}
	}

	private handleVcmpMessage(frameId: string, payload: string | undefined) {
		const message = payload ? JSON.parse(payload) : {} as any;
		const type = message["@type"];
		if (type) {
			const handler = this.resolver(type);
			if (handler) {
				asyncExecute(async () => {
					try {
						const result = await handler(message, this);
						this.sendFrame({
							type: "ACK",
							id: frameId,
							payload: result !== undefined ? JSON.stringify(result) : undefined,
						});
					}
					catch (error) {
						this.debug?.warn("Error in handler, sending NAK", error);
						this.sendFrame({type: "NAK", id: frameId, payload: JSON.stringify(createVcmpError(error))});
					}
				});
			}
			else {
				this.debug?.warn("No handler found for message, sending NAK", message);
				this.sendFrame({type: "NAK", id: frameId});
			}
		}
		else {
			this.debug?.error("Could not determine type of message", message);
		}
	}
}
