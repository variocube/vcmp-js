import {ServerOptions, WebSocketServer} from 'ws';
import {ConsoleLike, VcmpHandler, VcmpMessage, VcmpSession} from "@variocube/vcmp";

export type VcmpServerOptions = ServerOptions & {
    /** A sink for debug messages. */
    debug?: ConsoleLike;

    /** The heartbeat interval in milliseconds (default: 20000). */
    heartbeatInterval?: number;

    /** The web socket server. If none is passed, one is constructed from the passed options. */
    webSocketServer?: WebSocketServer;
}

export type SessionConnected = (session: VcmpSession) => any;
export type SessionDisconnected = (session: VcmpSession) => any;

export class VcmpServer {

    readonly #wss: WebSocketServer;

    readonly #handlers = new Map<string, VcmpHandler<any>>();
    readonly #sessions = new Set<VcmpSession>();

    public onSessionConnected: SessionConnected = () => void 0;
    public onSessionDisconnected: SessionDisconnected = () => void 0;

    constructor(options?: VcmpServerOptions) {
        const {
            debug,
            heartbeatInterval = 20000,
            webSocketServer,
            ...wssOptions
        } = options || {};


        this.#wss = webSocketServer ?? new WebSocketServer({
            ...wssOptions,
        });
        this.#wss.on("connection", webSocket => {
            const session = new VcmpSession({
                webSocket: webSocket,
                resolver: type => this.#handlers.get(type),
                debug: options?.debug,
            });

            session.onClose = () => {
                this.#sessions.delete(session);
                this.onSessionDisconnected(session);
            }

            session.initiateHeartbeat(heartbeatInterval);

            this.#sessions.add(session);
            this.onSessionConnected(session);
        });
    }

    stop() {
        return new Promise<void>((resolve, reject) => {
            // Close sessions
            this.#sessions.forEach(session => session.close());

            // Close server
            this.#wss.close(err => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }

    on<T extends VcmpMessage>(messageType: string, handler: VcmpHandler<T>) {
        this.#handlers.set(messageType, handler);
    }

    off<T extends VcmpMessage>(messageType: string) {
        this.#handlers.delete(messageType);
    }

    broadcast<T extends VcmpMessage>(message: T) {
        for (const session of this.#sessions) {
            session.send(message);
        }
    }

    get sessions() {
        return [...this.#sessions];
    }
}
