import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {VcmpSession} from "./session";
import NodeWebSocket from "ws";

export interface Options {
    reconnectTimeout: number;
    autoStart: boolean;
    customWebSocket?: (typeof NodeWebSocket) | (typeof WebSocket);
    debug?: ConsoleLike;
}

const defaultOptions: Options = {
    reconnectTimeout: 10000,
    autoStart: false,
};

export class VcmpClient {

    private readonly url: string;
    private readonly options: Options;

    private running = false;
    private waitingForReconnect = false;
    private session?: VcmpSession;

    private reconnectTimeout?: number | NodeJS.Timeout;

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
        if (this.session) {
            this.debug(`VcmpClient, websocket open, closing`);
            this.session.close();
        }
    }

    get connected() {
        return this.session?.isOpen;
    }

    send<T extends VcmpMessage>(message: T) {
        this.debug("Sending VcmpMessage", message);
        if (this.session) {
            return this.session.send(message);
        }
        else {
            return Promise.reject(new Error("No session."));
        }
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
            this.session = new VcmpSession({
                webSocket,
                resolver: type => this.handler.get(type),
                debug: this.options.debug
            });
            this.session.onOpen = this.handleOpen;
            this.session.onClose = this.handleClose;
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
        this.session = undefined;
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
        this.onOpen && this.onOpen();
    };

    private handleClose = () => {
        this.info("WebSocket session closed");
        this.onClose && this.onClose();
        this.scheduleReconnect();
    };

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
