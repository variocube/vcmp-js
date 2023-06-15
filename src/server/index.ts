import {Server, ServerOptions} from 'ws';
import {VcmpSession} from "../session";
import {ConsoleLike, VcmpHandler, VcmpMessage} from "../types";

export type VcmpServerOptions = ServerOptions & {
    /** A sink for debug messages. */
    debug?: ConsoleLike;

    /** The heartbeat interval in milliseconds (default: 20000). */
    heartbeatInterval?: number;
}

export type SessionConnected = (session: VcmpSession) => any;
export type SessionDisconnected = (session: VcmpSession) => any;

export class VcmpServer {

    private readonly wss: Server;

    private readonly handlers = new Map<string, VcmpHandler<any>>();
    private readonly sessions = new Set<VcmpSession>();

    public onSessionConnected: SessionConnected = () => void 0;
    public onSessionDisconnected: SessionDisconnected = () => void 0;

    constructor(options?: VcmpServerOptions) {
        const {
            debug,
            heartbeatInterval = 20000,
            ...wssOptions
        } = options || {};


        const wss = new Server({
            ...wssOptions,
        });
        wss.on("connection", ws => {
            const session = new VcmpSession({
                webSocket: ws,
                resolver: type => this.handlers.get(type),
                debug: options?.debug,
            });

            session.onClose = () => {
                this.sessions.delete(session);
                this.onSessionDisconnected(session);
            }

            session.initiateHeartbeat(heartbeatInterval);

            this.sessions.add(session);
            this.onSessionConnected(session);
        });


        this.wss = wss;
    }

    stop() {
        return new Promise<void>((resolve, reject) => {
            this.wss.close(err => {
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
        this.handlers.set(messageType, handler);
    }

    off<T extends VcmpMessage>(messageType: string) {
        this.handlers.delete(messageType);
    }

    broadcast<T extends VcmpMessage>(message: T) {
        for (const session of this.sessions) {
            session.send(message);
        }
    }
}
