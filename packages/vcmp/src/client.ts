import NodeWebSocket from "ws";
import {VcmpError} from "./error";
import {VcmpSession} from "./session";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";

export interface Options {
	reconnectTimeout: number;
	autoStart: boolean;
	/**
	 * Time in milliseconds within which the server must initiate a heartbeat after the
	 * connection opens; the session is closed (and reconnected) otherwise. This guards
	 * against a half-open connection through which no heartbeat ever arrives — without
	 * a running heartbeat, nothing would settle pending sends when the connection dies.
	 * A value of 0 or below disables the expectation. Default: 60000.
	 */
	initialHeartbeatTimeout: number;
	customWebSocket?: (typeof NodeWebSocket) | (typeof WebSocket);
	debug?: ConsoleLike;
}

const defaultOptions: Options = {
	reconnectTimeout: 10000,
	autoStart: false,
	initialHeartbeatTimeout: 60000,
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

		this.debug(`Constructed VcmpClient for URL ${this.url} and the following options`, this.options);

		if (this.options.autoStart) {
			this.debug(`Autostarting VcmpClient for URL: ${this.url}`);
			this.start();
		}
	}

	start() {
		this.debug(`Starting VcmpClient for URL: ${this.url}`);
		// Cancel a pending reconnect and discard an existing session: this call replaces
		// both with a fresh connection. Otherwise a still-armed reconnect timer would fire
		// later and open a second, duplicate connection.
		this.cancelReconnect();
		this.discardSession(true);
		this.running = true;
		this.initiateConnection();
	}

	stop() {
		this.debug(`Stopping VcmpClient for URL: ${this.url}`);
		this.running = false;
		this.cancelReconnect();
		this.discardSession(false);
	}

	private cancelReconnect() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout as any);
		}
		// Reset the flag so a later disconnect can schedule reconnects again;
		// otherwise the cleared timer above would never clear it.
		this.waitingForReconnect = false;
	}

	private discardSession(replacing: boolean) {
		const session = this.session;
		if (session) {
			this.debug(`Closing VCMP session`);
			// Detach the handlers before closing: the socket's events arrive asynchronously,
			// and must not affect a session created by a later start() — neither by firing
			// the application's onOpen/onClose nor by scheduling a reconnect.
			this.session = undefined;
			session.onOpen = undefined;
			// When a replacement follows (start()), suppress the close notification
			// entirely; otherwise (stop()) notify unless a new session appeared since.
			session.onClose = replacing ? undefined : () => {
				if (!this.session) {
					this.onClose && this.onClose();
				}
			};
			session.close();
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
			return Promise.reject(
				new VcmpError({
					title: "Session not open",
					status: 503,
					detail: "Cannot send message: the client has no session.",
				}),
			);
		}
	}

	private initiateConnection = () => {
		if (this.running) {
			this.debug("Initiating connection");
			const webSocketConstructor = this.options.customWebSocket || WebSocket;
			if (typeof webSocketConstructor !== "function") {
				throw new Error(
					"WebSocket constructor not found. If running on Node, please install the `ws` package and pass it as customWebSocket in options.",
				);
			}

			this.debug("Constructing websocket");
			const webSocket = new webSocketConstructor(this.url);
			this.debug("Connecting handlers");
			const session = new VcmpSession({
				webSocket,
				resolver: type => this.handler.get(type),
				debug: this.options.debug,
			});
			this.session = session;
			// Capture the session: an event may arrive after this session has been
			// replaced, and must not affect the session that replaced it.
			session.onOpen = () => this.handleSessionOpen(session);
			session.onClose = () => this.handleSessionClose(session);
		}
		else {
			this.debug("Not running, ignoring call to initiateConnection");
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

	private handleSessionOpen(session: VcmpSession) {
		if (this.session !== session) {
			this.debug("Ignoring open event of a replaced session");
			return;
		}
		this.debug("VCMP session open");
		// The server initiates the heartbeat; expect it to arrive, so that a half-open
		// connection through which no heartbeat ever comes is detected and closed.
		if (this.options.initialHeartbeatTimeout > 0) {
			session.expectHeartbeat(this.options.initialHeartbeatTimeout);
		}
		this.onOpen && this.onOpen();
	}

	private handleSessionClose(session: VcmpSession) {
		if (this.session !== session) {
			this.debug("Ignoring close event of a replaced session");
			return;
		}
		this.debug("VCMP session closed");
		this.onClose && this.onClose();
		this.scheduleReconnect();
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
