import {generateVcmpFrameId, parseVcmpFrame, serializeVcmpFrame, VcmpFrame, VcmpHeartbeatFrame} from "./frame";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {asyncExecute} from "./asyncExecute";
import NodeWebSocket, {MessageEvent} from "ws";
import {createVcmpError, VcmpError} from "./error";

type PromiseCallbacks = {
    resolve: (result?: any) => void;
    reject: (reason?: any) => void;
}

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
            const payload = JSON.stringify(message);
            const id = generateVcmpFrameId();
            this.callbacks.set(id, {resolve, reject});
            this.sendFrame({type: "MSG", id, payload});
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
        const promise = this.callbacks.get(frameId);
        if (promise) {
			const result = payload ? JSON.parse(payload) : undefined;
            promise.resolve(result);
        }
    }

    private handleNak(frameId: string, payload: string | undefined) {
        const promise = this.callbacks.get(frameId);
        if (promise) {
			const error = payload ? createVcmpError(JSON.parse(payload)) : new VcmpError({
				title: "Message handling failed",
				status: 500,
				detail: "Unspecified error in message handling."
			});
            promise.reject(error);
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
            reason: event.reason
        });
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout as any);
        }
        if (this.heartbeatReceiveTimeout) {
            clearTimeout(this.heartbeatReceiveTimeout as any);
        }
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
                        this.sendFrame({type: "ACK", id: frameId, payload: result ? JSON.stringify(result) : undefined});
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
