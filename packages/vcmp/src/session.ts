import {
    generateVcmpFrameId,
    parseVcmpFrame,
    serializeVcmpFrame,
    VcmpFrame,
    VcmpFrameType,
    VcmpHeartbeatFrame
} from "./frame";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {asyncExecute} from "./asyncExecute";
import NodeWebSocket from "ws";
import {MessageEvent} from "ws";

type PromiseCallbacks = {
    resolve: () => void;
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
        return new Promise<void>((resolve, reject) => {
            const payload = JSON.stringify(message);
            const id = generateVcmpFrameId();
            this.callbacks.set(id, {resolve, reject});
            this.sendFrame({type: VcmpFrameType.MSG, id, payload});
        });
    }

    close() {
        this.webSocket.close();
    }

    get isOpen() {
        return this.webSocket.readyState == 1; // 1...OPEN
    }

    initiateHeartbeat(heartbeatInterval: number) {
        this.sendFrame({type: VcmpFrameType.HBT, heartbeatInterval});
    }

    private handleAck(frameId: string) {
        const promise = this.callbacks.get(frameId);
        if (promise) {
            promise.resolve();
        }
    }

    private handleNak(frameId: string) {
        const promise = this.callbacks.get(frameId);
        if (promise) {
            promise.reject("NAK");
        }
    }

    private sendFrame(frame: VcmpFrame) {
        if (this.webSocket) {
            this.webSocket.send(serializeVcmpFrame(frame));
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
        if (this.webSocket.readyState == 0 || this.webSocket.readyState == 1) {
            this.webSocket.close();
        }
    };

    private handleMessage = (event: MessageEvent | NodeWebSocket.MessageEvent) => {
        if (typeof event.data == "string") {
            const frame = parseVcmpFrame(event.data);
            switch (frame.type) {
                case VcmpFrameType.HBT:
                    this.handleHeartbeatReceived(frame);
                    break;

                case VcmpFrameType.ACK:
                    this.handleAck(frame.id);
                    break;

                case VcmpFrameType.NAK:
                    this.handleNak(frame.id);
                    break;

                case VcmpFrameType.MSG:
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

    private handleVcmpMessage(frameId: string, payload: string) {
        const message = JSON.parse(payload);
        const type = message["@type"];
        if (type) {
            const handler = this.resolver(type);
            if (handler) {
                asyncExecute(async () => {
                    try {
                        await handler(message, this);
                        this.sendFrame({type: VcmpFrameType.ACK, id: frameId});
                    }
                    catch (error) {
                        this.debug?.warn("Error in handler, sending NAK", error);
                        this.sendFrame({type: VcmpFrameType.NAK, id: frameId});
                    }
                });
            }
            else {
                this.debug?.warn("No handler found for message, sending NAK", message);
                this.sendFrame({type: VcmpFrameType.NAK, id: frameId});
            }
        }
        else {
            this.debug?.error("Could not determine type of message", message);
        }
    }

}