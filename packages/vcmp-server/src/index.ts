import {
	ConsoleLike,
	DEFAULT_AUTHENTICATION_TIMEOUT,
	VcmpAuthentication,
	VcmpAuthenticationSource,
	VcmpCredential,
	VcmpHandler,
	VcmpMessage,
	VcmpSession,
} from "@variocube/vcmp";
import {IncomingMessage} from "http";
import {isDeepStrictEqual} from "util";
import {ServerOptions, WebSocket, WebSocketServer} from "ws";

/**
 * Authenticates the credential of an `AUT` frame. Returns the principal, optionally with an expiry and
 * endpoint-defined `ACK` members, or throws to reject: a `VcmpError`/problem detail with status 400, 401
 * or 403 is answered with that status; anything else is an unexpected failure, answered with a `NAK` 500
 * (its message never reaches the client). Either way, a failed first authentication closes the session and a
 * failed re-authentication keeps it until its current expiry.
 */
export type VcmpAuthenticator<P> = (
	credential: VcmpCredential,
	session: VcmpSession<P>,
) => VcmpAuthentication<P> | Promise<VcmpAuthentication<P>>;

/**
 * Transition mode: authenticates a session by its handshake request (URL, headers), for old clients that
 * send their credential there. Returns the authentication when the handshake carries a valid credential,
 * `undefined` when it carries none (the session then waits for an `AUT`), and throws (or rejects) when the
 * credential is invalid, which closes the session (1008).
 */
export type VcmpHandshakeAuthenticator<P> = (
	request: IncomingMessage,
	session: VcmpSession<P>,
) => VcmpAuthentication<P> | undefined | Promise<VcmpAuthentication<P> | undefined>;

export interface VcmpServerAuthentication<P> {
	/** Authenticates the credential of an `AUT` frame. */
	authenticate: VcmpAuthenticator<P>;
	/** Transition mode only: authenticates old clients by their handshake. */
	authenticateHandshake?: VcmpHandshakeAuthenticator<P>;
	/** Time in milliseconds from connect within which a session must authenticate (default: 10000). */
	timeout?: number;
	/**
	 * Whether a re-authentication's principal equals the session's; a different one closes the session.
	 * Default: deep (structural) equality.
	 */
	principalEquals?: (a: P, b: P) => boolean;
}

export type VcmpServerOptions<P = unknown> = ServerOptions & {
	/** A sink for debug messages. */
	debug?: ConsoleLike;

	/** The heartbeat interval in milliseconds (default: 20000). */
	heartbeatInterval?: number;

	/** The web socket server. If none is passed, one is constructed from the passed options. */
	webSocketServer?: WebSocketServer;

	/**
	 * Requires every session to authenticate (VCMP session authentication, `AUT` frame). Without it, the
	 * server answers an `AUT` with `NAK` 400 and behaves as before.
	 */
	authentication?: VcmpServerAuthentication<P>;
};

export type SessionConnected<P = unknown> = (session: VcmpSession<P>) => any;
export type SessionDisconnected<P = unknown> = (session: VcmpSession<P>) => any;

/** How many sessions were authenticated by their handshake (transition mode) and by an `AUT` frame. */
export interface VcmpAuthenticationCounts {
	handshake: number;
	aut: number;
}

export class VcmpServer<P = unknown> {
	readonly #wss: WebSocketServer;
	readonly #debug?: ConsoleLike;

	readonly #handlers = new Map<string, VcmpHandler<any>>();
	// Connected sessions only: with authentication, a session is connected once it authenticated
	readonly #sessions = new Set<VcmpSession<P>>();
	// Sessions that have not authenticated yet; closed by stop() too
	readonly #unauthenticatedSessions = new Set<VcmpSession<P>>();
	readonly #authenticationCounts: VcmpAuthenticationCounts = {handshake: 0, aut: 0};

	/**
	 * Raised when a session connects; with `authentication`, only once it authenticated, so that no
	 * application code ever sees an unauthenticated session.
	 */
	public onSessionConnected: SessionConnected<P> = () => void 0;
	/** Raised when a session that was connected (see `onSessionConnected`) disconnects. */
	public onSessionDisconnected: SessionDisconnected<P> = () => void 0;

	constructor(options?: VcmpServerOptions<P>) {
		const {
			debug,
			heartbeatInterval = 20000,
			webSocketServer,
			authentication,
			...wssOptions
		} = options || {};

		this.#debug = debug;
		this.#wss = webSocketServer ?? new WebSocketServer({
			...wssOptions,
		});
		this.#wss.on("connection", (webSocket: WebSocket, request: IncomingMessage) => {
			if (authentication) {
				this.#acceptAuthenticated(webSocket, request, authentication, heartbeatInterval);
				return;
			}
			const session = new VcmpSession<P>({
				webSocket: webSocket,
				resolver: type => this.#handlers.get(type),
				debug: options?.debug,
			});

			session.onClose = () => {
				this.#sessions.delete(session);
				this.onSessionDisconnected(session);
			};

			// Register the session before starting the heartbeat: a failing first heartbeat
			// abandons the session synchronously, and its disconnect must follow the connect.
			// A throwing onSessionConnected must not leave the session without a heartbeat.
			this.#sessions.add(session);
			try {
				this.onSessionConnected(session);
			}
			finally {
				session.initiateHeartbeat(heartbeatInterval);
			}
		});
	}

	#acceptAuthenticated(
		webSocket: WebSocket,
		request: IncomingMessage,
		authentication: VcmpServerAuthentication<P>,
		heartbeatInterval: number,
	) {
		const {authenticate, authenticateHandshake, timeout, principalEquals} = authentication;
		const session: VcmpSession<P> = new VcmpSession<P>({
			webSocket: webSocket,
			resolver: type => this.#handlers.get(type),
			debug: this.#debug,
			serverAuthentication: {
				authenticate: credential => authenticate(credential, session),
				timeout: timeout ?? DEFAULT_AUTHENTICATION_TIMEOUT,
				principalEquals: principalEquals ?? isDeepStrictEqual,
			},
		});

		let connected = false;
		session.onAuthenticated = ({source, reauthentication}) => {
			if (reauthentication || connected) {
				return;
			}
			this.#countAuthentication(source);
			connected = true;
			this.#unauthenticatedSessions.delete(session);
			this.#sessions.add(session);
			this.onSessionConnected(session);
		};
		session.onClose = () => {
			this.#unauthenticatedSessions.delete(session);
			if (connected) {
				this.#sessions.delete(session);
				this.onSessionDisconnected(session);
			}
		};

		this.#unauthenticatedSessions.add(session);
		// The heartbeat runs from connect, so that a dead connection is detected while it authenticates
		try {
			if (authenticateHandshake) {
				session.authenticateHandshake(() => authenticateHandshake(request, session));
			}
		}
		finally {
			session.initiateHeartbeat(heartbeatInterval);
		}
	}

	#countAuthentication(source: VcmpAuthenticationSource) {
		this.#authenticationCounts[source]++;
		const {handshake, aut} = this.#authenticationCounts;
		this.#debug?.info(
			`Session authenticated by ${source == "handshake" ? "handshake" : "AUT"}`
				+ ` (sessions authenticated so far: ${handshake} by handshake, ${aut} by AUT)`,
		);
	}

	/**
	 * How many sessions were authenticated by their handshake (transition mode) and by an `AUT` frame since
	 * the server started: once no session authenticates by handshake any more, the handshake authenticator
	 * can be removed.
	 */
	get authenticationCounts(): VcmpAuthenticationCounts {
		return {...this.#authenticationCounts};
	}

	stop() {
		return new Promise<void>((resolve, reject) => {
			// Close sessions
			this.#sessions.forEach(session => session.close());
			this.#unauthenticatedSessions.forEach(session => session.close());

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
	 * Broadcasts a message to every connected session (with authentication: every authenticated one).
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

	/** The connected sessions (with authentication: the authenticated ones). */
	get sessions() {
		return [...this.#sessions];
	}
}
