import {generateVcmpFrameId, parseVcmpFrame, serializeVcmpFrame, VcmpFrame, VcmpFrameType} from "./frame";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {asyncExecute} from "./asyncExecute";
import * as NodeWebSocket from "ws";
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
        return this.webSocket.readyState == WebSocket.OPEN; // 1...OPEN
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
        this.debug?.info("WebSocket session open");
        this.onOpen && this.onOpen();
    };

    private handleClose = (event: CloseEvent | NodeWebSocket.CloseEvent) => {
        this.debug?.info("WebSocket session closed", event);
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout as any);
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
            const frame = parseVcmpFrame(event.data);
            switch (frame.type) {
                case VcmpFrameType.HBT:
                    this.heartbeatTimeout = setTimeout(() => this.sendFrame(frame), frame.heartbeatInterval);
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