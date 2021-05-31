import {generateVcmpFrameId, parseVcmpFrame, serializeVcmpFrame, VcmpFrame, VcmpFrameType} from "./frame";

export interface Options {
    reconnectTimeout: number;
    autoStart: boolean;
    customWebSocket?: typeof WebSocket;
    debug?: ConsoleLike;
}

const defaultOptions: Options = {
    reconnectTimeout: 10000,
    autoStart: false,
};

type PromiseCallbacks = {
    resolve: () => void;
    reject: (reason?: any) => void;
}

export type VcmpHandler<T> = (message: T) => Promise<void> | void;
export type OpenHandler = () => any;
export type CloseHandler = () => any;

export interface VcmpMessage {
    "@type": string;
}

export interface ConsoleLike {
    info(...data: any[]): void;

    debug(...data: any[]): void;

    warn(...data: any[]): void;

    error(...data: any[]): void;
}

export class VcmpClient {

    private readonly url: string;
    private readonly options: Options;

    private running = false;
    private isConnected = false;
    private waitingForReconnect = false;
    private webSocket?: WebSocket;

    private heartbeatTimeout?: number | NodeJS.Timeout;
    private reconnectTimeout?: number | NodeJS.Timeout;

    private callbacks = new Map<string, PromiseCallbacks>();
    private handler = new Map<string, VcmpHandler<any>>();

    public onOpen?: OpenHandler;
    public onClose?: CloseHandler;

    constructor(url: string, options?: Partial<Options>) {

        this.url = url;

        this.options = {
            ...defaultOptions,
            ...options,
        };

        this.debug(`Constructed VcmpClient for URL: ${this.url} and the following options`, this.options);

        if (this.options.autoStart) {
            this.debug(`Autostarting VcmpClient for URL: ${this.url}`);
            this.start();
        }
    }

    start() {
        this.debug(`Starting VcmpClient for URL: ${this.url}`);
        this.running = true;
        this.initiateConnection();
    }

    stop() {
        this.debug(`Stopping VcmpClient for URL: ${this.url}`);
        this.running = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout as any);
        }
        if (this.webSocket) {
            this.debug(`VcmpClient, websocket open, closing`);
            this.webSocket.close();
        }
    }

    get connected() {
        return this.isConnected;
    }

    send<T extends VcmpMessage>(message: T) {
        this.debug("Sending VcmpMessage", message);
        return new Promise<void>((resolve, reject) => {
            const payload = JSON.stringify(message);
            const id = generateVcmpFrameId();
            this.callbacks.set(id, {resolve, reject});
            this.sendFrame({type: VcmpFrameType.MSG, id, payload});
        });
    }

    private initiateConnection = () => {
        this.debug("Initiating connection");
        if (this.running) {
            this.debug("Initiating connection");
            const webSocketConstructor = this.options.customWebSocket || WebSocket;
            if (typeof webSocketConstructor !== "function") {
                throw new Error("WebSocket constructor not found. If running on Node, please install the `ws` package and pass it as customWebSocket in options.");
            }

            this.debug("Constructing websocket");
            const webSocket = new webSocketConstructor(this.url);
            this.debug("Connecting handlers");
            webSocket.onmessage = this.handleMessage;
            webSocket.onopen = this.handleOpen;
            webSocket.onerror = this.handleError;
            webSocket.onclose = this.handleClose;
            this.webSocket = webSocket;
        }
        else {
            this.debug("Already running, ignoring call to initiateConnection");
        }
    };

    on<T>(type: string, handler: VcmpHandler<T>) {
        this.handler.set(type, handler);
    }

    off(type: string) {
        this.handler.delete(type);
    }

    private scheduleReconnect() {
        this.debug("Checking whether to schedule reconnect.");
        this.webSocket = undefined;
        if (this.running && !this.waitingForReconnect) {
            this.debug("Scheduling reconnect.");
            this.waitingForReconnect = true;
            this.reconnectTimeout = setTimeout(() => {
                this.waitingForReconnect = false;
                this.initiateConnection();
            }, this.options.reconnectTimeout);
        }
    }

    private handleOpen = () => {
        this.info("WebSocket session open");
        this.isConnected = true;
        this.onOpen && this.onOpen();
    };

    private handleClose = (event: CloseEvent) => {
        this.info("WebSocket session closed", event);
        this.isConnected = false;
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout as any);
        }
        this.onClose && this.onClose();
        this.scheduleReconnect();
    };

    private handleError = () => {
        this.warn("WebSocket session error");
        if (this.webSocket) {
            this.webSocket.close();
        }
    };

    private handleMessage = (event: MessageEvent) => {
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
            const handler = this.handler.get(type);
            if (handler) {
                asyncExecute(async () => {
                    try {
                        await handler(message);
                        this.sendFrame({type: VcmpFrameType.ACK, id: frameId});
                    }
                    catch (error) {
                        this.warn("Error in handler, sending NAK", error);
                        this.sendFrame({type: VcmpFrameType.NAK, id: frameId});
                    }
                });
            }
            else {
                this.warn("No handler found for message, sending NAK", message);
                this.sendFrame({type: VcmpFrameType.NAK, id: frameId});
            }
        }
        else {
            this.error("Could not determine type of message", message);
        }
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

    private info(...data: any[]) {
        this.options.debug?.info(...data);
    }

    private debug(...data: any[]) {
        this.options.debug?.debug(...data);
    }

    private warn(...data: any[]) {
        this.options.debug?.warn(...data);
    }

    private error(...data: any[]) {
        this.options.debug?.error(...data);
    }
}

function detectAsyncExecute() {
    if (typeof queueMicrotask == "function") {
        return queueMicrotask;
    }
    else if (typeof setImmediate == "function") {
        return setImmediate;
    }
    else {
        return (callback: VoidFunction) => Promise.resolve().then(callback);
    }
}

const asyncExecute = detectAsyncExecute();

