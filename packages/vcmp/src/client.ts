import {
	DEFAULT_AUTHENTICATION_TIMEOUT,
	DEFAULT_REFRESH_RETRY_DELAY,
	VcmpAuthenticatedEvent,
	VcmpAuthenticationAck,
} from "./authentication";
import {VcmpError} from "./error";
import {VcmpSession} from "./session";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {VcmpWebSocketConstructor} from "./webSocket";

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
	/**
	 * A WebSocket implementation to use instead of the global `WebSocket`, for example the class
	 * exported by the `ws` package when running on Node.
	 */
	customWebSocket?: VcmpWebSocketConstructor;
	debug?: ConsoleLike;
	/**
	 * Authenticates every session with an `AUT` frame (VCMP session authentication): called on every
	 * (re)connect and before the authentication expires, it provides the credential, a JSON object whose
	 * shape the endpoint defines (e.g. `{token: "…"}`). With it set, `onOpen` is raised and `connected`
	 * becomes `true` only once the server acknowledged the authentication; messages sent before are held
	 * back until then. Failures are reported via `onAuthenticationError`.
	 */
	authenticate?: () => Promise<object> | object;
	/**
	 * Time in milliseconds within which the server must answer an `AUT`; otherwise the authentication
	 * fails (status 504) and the session is closed and reconnected. Default: 10000.
	 */
	authenticationTimeout: number;
	/**
	 * How long before the authentication expires (the `ACK`'s `expiresIn`) the client re-authenticates,
	 * in milliseconds: fixed, or computed from `expiresIn`. Default: `min(60 s, 20 % of expiresIn)`. The
	 * effective lead time is at most `expiresIn / 2`, and a refresh is never sent sooner than 1 s after the
	 * `ACK` (see `computeRefreshDelay`).
	 */
	refreshLeadTime?: number | ((expiresIn: number) => number);
	/**
	 * Delay in milliseconds before a failed re-authentication (a `NAK`, or a failing credential provider) is
	 * retried; retries stop at the expiry, when the server closes the session. A re-authentication the server
	 * doesn't answer within `authenticationTimeout` is not retried: the session is closed and reconnected.
	 * Default: 5000.
	 */
	refreshRetryDelay: number;
}

const defaultOptions: Options = {
	reconnectTimeout: 10000,
	autoStart: false,
	initialHeartbeatTimeout: 60000,
	authenticationTimeout: DEFAULT_AUTHENTICATION_TIMEOUT,
	refreshRetryDelay: DEFAULT_REFRESH_RETRY_DELAY,
};

export class VcmpClient {
	private readonly url: string;
	private readonly options: Options;

	private running = false;
	private waitingForReconnect = false;
	private session?: VcmpSession;

	private reconnectTimeout?: number | NodeJS.Timeout;

	private handler = new Map<string, VcmpHandler<any>>();

	/** Raised when a session is ready: on open or, with `authenticate` set, on the first `ACK` to an `AUT`. */
	public onOpen?: OpenHandler;
	public onClose?: CloseHandler;
	/**
	 * Raised on every `ACK` to an `AUT` (first and refreshes) with its payload: `expiresIn` and the
	 * endpoint's own members. For the first one, it is raised before `onOpen`.
	 */
	public onAuthenticated?: (ack: VcmpAuthenticationAck) => void;
	/**
	 * Raised when an authentication fails: a `NAK` (the server's problem detail: 400, 401 or 403), no
	 * answer within `authenticationTimeout` (status 504), or a failing credential provider (status 500).
	 * A failed first authentication closes the session, which reconnects after `reconnectTimeout`.
	 */
	public onAuthenticationError?: (error: VcmpError) => void;

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
			session.onAuthenticated = undefined;
			session.onAuthenticationError = undefined;
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
		const session = this.session;
		return session?.isOpen && (!this.options.authenticate || session.isAuthenticated);
	}

	/** The payload of the current session's last `ACK` to an `AUT`, if it authenticated. */
	get authentication() {
		return this.session?.authentication;
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
			const {authenticate, authenticationTimeout, refreshLeadTime, refreshRetryDelay} = this.options;
			const session = new VcmpSession({
				webSocket,
				resolver: type => this.handler.get(type),
				debug: this.options.debug,
				clientAuthentication: authenticate
					? {authenticate, timeout: authenticationTimeout, refreshLeadTime, refreshRetryDelay}
					: undefined,
			});
			this.session = session;
			// Capture the session: an event may arrive after this session has been
			// replaced, and must not affect the session that replaced it.
			session.onOpen = () => this.handleSessionOpen(session);
			session.onClose = () => this.handleSessionClose(session);
			session.onAuthenticated = event => this.handleSessionAuthenticated(session, event);
			session.onAuthenticationError = error => this.handleSessionAuthenticationError(session, error);
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
		// With authentication, the session is ready only once the server acknowledged it
		if (!this.options.authenticate) {
			this.onOpen && this.onOpen();
		}
	}

	private handleSessionAuthenticated(session: VcmpSession, event: VcmpAuthenticatedEvent) {
		if (this.session !== session) {
			return;
		}
		this.debug(event.reauthentication ? "VCMP session re-authenticated" : "VCMP session authenticated");
		this.onAuthenticated && this.onAuthenticated(event.ack);
		if (!event.reauthentication && this.session === session) {
			this.onOpen && this.onOpen();
		}
	}

	private handleSessionAuthenticationError(session: VcmpSession, error: VcmpError) {
		if (this.session !== session) {
			return;
		}
		this.onAuthenticationError && this.onAuthenticationError(error);
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
