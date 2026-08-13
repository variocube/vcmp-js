import {ConsoleLike, VcmpHandler, VcmpMessage, VcmpSession} from "@variocube/vcmp";
import {ServerOptions, WebSocketServer} from "ws";

export type VcmpServerOptions = ServerOptions & {
	/** A sink for debug messages. */
	debug?: ConsoleLike;

	/** The heartbeat interval in milliseconds (default: 20000). */
	heartbeatInterval?: number;

	/** The web socket server. If none is passed, one is constructed from the passed options. */
	webSocketServer?: WebSocketServer;
};

export type SessionConnected = (session: VcmpSession) => any;
export type SessionDisconnected = (session: VcmpSession) => any;

export class VcmpServer {
	readonly #wss: WebSocketServer;
	readonly #debug?: ConsoleLike;

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

		this.#debug = debug;
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
			};

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

	/**
	 * Broadcasts a message to every connected session.
	 *
	 * Returns a promise that always resolves (never rejects) with one entry per session,
	 * carrying either the session's ACK `result` or its `error` (e.g. a NAK, or the
	 * session closing mid-broadcast) — so callers can observe per-session failures.
	 * Ignoring the returned promise is safe: rejections are handled internally and
	 * reported via the debug sink.
	 */
	broadcast<T extends VcmpMessage>(message: T) {
		return Promise.all([...this.#sessions].map(session =>
			session.send(message).then(
				result => ({session, result, error: undefined}),
				error => {
					this.#debug?.warn("Broadcast send failed", error);
					return {session, result: undefined, error};
				},
			)
		));
	}

	get sessions() {
		return [...this.#sessions];
	}
}
