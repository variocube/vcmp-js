import {Server, ServerOptions} from 'ws';
import {VcmpSession} from "./session";
import {ConsoleLike, VcmpHandler, VcmpMessage} from "./types";

export type VcmpServerOptions = ServerOptions & {
    debug?: ConsoleLike;
    heartbeatInterval?: number;
}

export class VcmpServer {

    private readonly wss: Server;

    private readonly handlers = new Map<string, VcmpHandler<any>>();
    private readonly sessions = new Set<VcmpSession>();

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
            session.onClose = () => this.sessions.delete(session);
            session.initiateHeartbeat(heartbeatInterval);
            this.sessions.add(session);
        });


        this.wss = wss;
    }

    close() {
        this.wss.close();
    }

    broadcast<T extends VcmpMessage>(message: T) {
        for (const session of this.sessions) {
            session.send(message);
        }
    }
}
