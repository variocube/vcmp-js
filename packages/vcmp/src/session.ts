import {asyncExecute} from "./asyncExecute";
import {
	AUTHENTICATION_CLOSE_CODE,
	AuthenticationCloseReason,
	authenticationError,
	CLIENT_AUTHENTICATION_CLOSE_CODE,
	computeRefreshDelay,
	isCredential,
	validateClientAuthentication,
	VcmpAuthenticatedEvent,
	VcmpAuthentication,
	VcmpAuthenticationAck,
	VcmpCredential,
	VcmpSessionClientAuthentication,
	VcmpSessionServerAuthentication,
} from "./authentication";
import {createVcmpError, isProblemDetail, ProblemDetail, VcmpError} from "./error";
import {
	describeVcmpFrame,
	generateVcmpFrameId,
	parseVcmpFrame,
	serializeVcmpFrame,
	VcmpFrame,
	VcmpHeartbeatFrame,
	VcmpMessageFrame,
} from "./frame";
import {LongTimeout, setLongTimeout} from "./longTimeout";
import {CloseHandler, ConsoleLike, OpenHandler, VcmpHandler, VcmpMessage} from "./types";
import {VcmpCloseEvent, VcmpMessageEvent, VcmpWebSocket} from "./webSocket";

type PromiseCallbacks = {
	resolve: (result?: any) => void;
	reject: (reason?: any) => void;
};

export interface VcmpSessionOptions<P = unknown> {
	webSocket: VcmpWebSocket;
	resolver: (type: string) => VcmpHandler<any> | undefined;
	debug?: ConsoleLike;
	/**
	 * Client role: authenticate the session with an `AUT` frame as soon as the socket opens. Until the
	 * server's `ACK`, every sent message is held back.
	 */
	clientAuthentication?: VcmpSessionClientAuthentication;
	/**
	 * Server role: the session must authenticate (with an `AUT` frame, or by its handshake, see
	 * {@link VcmpSession.authenticateHandshake}) within the timeout, counted from constructing the session.
	 * Until then only `HBT` and `AUT` frames are accepted.
	 */
	serverAuthentication?: VcmpSessionServerAuthentication<P>;
}

export class VcmpSession<P = unknown> {
	constructor({webSocket, resolver, debug, clientAuthentication, serverAuthentication}: VcmpSessionOptions<P>) {
		webSocket.onmessage = this.handleMessage;
		webSocket.onerror = this.handleError;
		webSocket.onopen = this.handleOpen;
		webSocket.onclose = this.handleClose;

		this.webSocket = webSocket;
		this.resolver = resolver;
		this.debug = debug;
		if (clientAuthentication) {
			validateClientAuthentication(clientAuthentication);
		}
		this.clientAuthentication = clientAuthentication;
		this.serverAuthentication = serverAuthentication;

		if (serverAuthentication) {
			this.authenticationTimeout = setLongTimeout(
				() => this.closeForPolicy(AuthenticationCloseReason.TIMEOUT),
				serverAuthentication.timeout,
			);
		}
	}

	private readonly webSocket: VcmpWebSocket;
	private readonly resolver: (type: string) => VcmpHandler<any> | undefined;
	private readonly debug?: ConsoleLike;
	private readonly clientAuthentication?: VcmpSessionClientAuthentication;
	private readonly serverAuthentication?: VcmpSessionServerAuthentication<P>;

	public onOpen?: OpenHandler;
	public onClose?: CloseHandler;
	/** Raised on every successful authentication (first and re-authentications), in both roles. */
	public onAuthenticated?: (event: VcmpAuthenticatedEvent) => void;
	/**
	 * Client role: raised when an authentication fails — a `NAK` (carrying the server's problem detail),
	 * no answer within the timeout (status 504), or a failing credential provider (status 500).
	 */
	public onAuthenticationError?: (error: VcmpError) => void;

	private heartbeatTimeout?: number | NodeJS.Timeout;
	private heartbeatReceiveTimeout?: number | NodeJS.Timeout;
	private awaitingHeartbeat = true;
	private initiatedHeartbeatInterval?: number;
	// Set once the session has closed — by the socket's close event or by abandon(). A closed
	// session ignores all later socket events, so that it closes exactly once.
	private closed = false;

	private callbacks = new Map<string, PromiseCallbacks>();

	// --- authentication (see VcmpSessionOptions.clientAuthentication / serverAuthentication) ---
	private authenticated = false;
	private authenticatedPrincipal?: P;
	private authenticationAck?: VcmpAuthenticationAck;
	// An AUT is in flight: being processed (server) or awaiting its answer (client)
	private authenticationPending = false;
	// Set once the session is being closed for a policy violation: it then ignores every inbound frame
	private policyClosing = false;
	// Server: the timeout for the first authentication, and the authentication's expiry
	private authenticationTimeout?: LongTimeout;
	private expiryTimeout?: LongTimeout;
	// Server: inbound events received while an asynchronous handshake authentication is running
	private heldInbound?: VcmpMessageEvent[];
	// Client: the id of the AUT awaiting its answer, the answer timeout, the refresh timer and the
	// expiry (local clock, counted from receiving the ACK)
	private pendingAuthenticationId?: string;
	private pendingAuthenticationIsRefresh = false;
	private currentAttempt?: object;
	private answerTimeout?: ReturnType<typeof setTimeout>;
	private refreshTimeout?: LongTimeout;
	private expiresAt?: number;
	// Client: messages sent before the first ACK, sent once it arrives
	private heldOutbound: VcmpMessageFrame[] = [];

	send<T extends VcmpMessage>(message: T) {
		this.debug?.debug("Sending VcmpMessage", message);
		return new Promise<any>((resolve, reject) => {
			if (!this.isOpen) {
				reject(
					new VcmpError({
						title: "Session not open",
						status: 503,
						detail: "Cannot send message: the WebSocket is not open.",
					}),
				);
				return;
			}
			if (this.serverAuthentication && !this.authenticated) {
				// Server-initiated messages never reach a session that isn't authenticated
				reject(
					new VcmpError({
						title: "Session not authenticated",
						status: 503,
						detail: "Cannot send message: the session is not authenticated.",
					}),
				);
				return;
			}
			const payload = JSON.stringify(message);
			const id = generateVcmpFrameId();
			// Register before sending: a synchronously-delivering WebSocket (in-memory pairs,
			// test doubles passed via customWebSocket) can deliver the ACK during sendFrame.
			this.callbacks.set(id, {resolve, reject});
			if (this.clientAuthentication && !this.authenticated) {
				// Held back until the server acknowledges the authentication
				this.heldOutbound.push({type: "MSG", id, payload});
				return;
			}
			try {
				this.sendFrame({type: "MSG", id, payload});
			}
			catch (error) {
				this.callbacks.delete(id);
				// Wrap so that every rejection of send() is a VcmpError, as documented.
				throw new VcmpError({
					title: "Send failed",
					status: 503,
					detail: "The message could not be sent.",
					cause: error,
				});
			}
		});
	}

	close() {
		this.webSocket.close();
	}

	get isOpen() {
		// An abandoned socket may still report OPEN until its termination completes, and a socket closed
		// for a policy violation until its close handshake completes
		return !this.closed && !this.policyClosing && this.webSocket.readyState == 1; // 1...OPEN
	}

	/** Whether the session is authenticated (always `false` for a session that doesn't authenticate). */
	get isAuthenticated() {
		return this.authenticated;
	}

	/** Server role: what the session is authenticated as; `undefined` until it is. */
	get principal(): P | undefined {
		return this.authenticatedPrincipal;
	}

	/** Client role: the payload of the last `ACK` to an `AUT`; `undefined` until the first. */
	get authentication(): VcmpAuthenticationAck | undefined {
		return this.authenticationAck;
	}

	/**
	 * Server role, transition mode: authenticates the session by its handshake. `authenticate` returns
	 * the authentication when the handshake carries a valid credential, `undefined` when it carries
	 * none (the session then waits for an `AUT`), and throws (or rejects) when the credential is
	 * invalid, which closes the session. Inbound frames are held back while an asynchronous handshake
	 * authentication runs. Call it at most once, right after constructing the session.
	 */
	authenticateHandshake(
		authenticate: () => VcmpAuthentication<P> | undefined | Promise<VcmpAuthentication<P> | undefined>,
	) {
		if (!this.serverAuthentication) {
			throw new Error("Handshake authentication requires serverAuthentication.");
		}
		let result: VcmpAuthentication<P> | undefined | Promise<VcmpAuthentication<P> | undefined>;
		try {
			result = authenticate();
		}
		catch (error) {
			this.handshakeRejected(error);
			return;
		}
		if (isThenable(result)) {
			this.heldInbound = [];
			result.then(
				authentication => {
					try {
						this.handshakeAuthenticated(authentication);
					}
					catch (error) {
						this.debug?.warn("Error while raising the authentication of a session", error);
					}
					finally {
						this.releaseHeldInbound();
					}
				},
				error => {
					this.heldInbound = undefined;
					this.handshakeRejected(error);
				},
			);
		}
		else {
			this.handshakeAuthenticated(result);
		}
	}

	private handshakeAuthenticated(authentication: VcmpAuthentication<P> | undefined) {
		if (this.closed || this.policyClosing || authentication === undefined) {
			// No credential in the handshake: the session waits for an AUT
			return;
		}
		if (!isValidAuthentication(authentication)) {
			this.handshakeRejected(new Error("The handshake authenticator returned an invalid authentication."));
			return;
		}
		const expiresIn = expiresInOf(authentication.expiresAt);
		if (expiresIn !== undefined && expiresIn <= 0) {
			this.handshakeRejected(new Error("The handshake credential has expired."));
			return;
		}
		this.authenticated = true;
		this.authenticatedPrincipal = authentication.principal;
		this.authenticationTimeout?.clear();
		this.armExpiry(expiresIn);
		this.onAuthenticated?.({source: "handshake", reauthentication: false, ack: {}});
	}

	private handshakeRejected(error: unknown) {
		this.debug?.info("Handshake authentication failed", describeError(error));
		this.closeForPolicy(AuthenticationCloseReason.FAILED);
	}

	private releaseHeldInbound() {
		const held = this.heldInbound;
		this.heldInbound = undefined;
		for (const event of held ?? []) {
			this.handleMessage(event);
		}
	}

	/**
	 * Closes the session for an authentication reason: a server with 1008 (policy violation), a client with
	 * 4008, since a browser's WebSocket only lets a client close with 1000 or 3000–4999. From here on the
	 * session ignores every inbound frame and refuses to send; it closes (raising `onClose`) with the socket's
	 * close event.
	 */
	private closeForPolicy(reason: string) {
		if (this.closed || this.policyClosing) {
			return;
		}
		this.policyClosing = true;
		this.debug?.info("Closing session:", reason);
		this.clearAuthenticationTimers();
		this.heldInbound = undefined;
		try {
			this.webSocket.close(
				this.clientAuthentication ? CLIENT_AUTHENTICATION_CLOSE_CODE : AUTHENTICATION_CLOSE_CODE,
				reason,
			);
		}
		catch (error) {
			this.debug?.warn("Could not close the WebSocket", error);
			this.abandon(reason);
		}
	}

	private clearAuthenticationTimers() {
		this.authenticationTimeout?.clear();
		this.expiryTimeout?.clear();
		this.refreshTimeout?.clear();
		clearTimeout(this.answerTimeout as any);
	}

	/** Server: (re)arms the expiry, or removes it (`undefined`). */
	private armExpiry(expiresIn: number | undefined) {
		this.expiryTimeout?.clear();
		this.expiryTimeout = undefined;
		if (expiresIn !== undefined) {
			this.expiryTimeout = setLongTimeout(
				() => this.closeForPolicy(AuthenticationCloseReason.EXPIRED),
				expiresIn,
			);
		}
	}

	initiateHeartbeat(heartbeatInterval: number) {
		this.initiatedHeartbeatInterval = heartbeatInterval;
		if (this.isOpen) {
			this.sendHeartbeat({type: "HBT", heartbeatInterval});
		}
		// otherwise the heartbeat starts once the socket opens (see handleOpen) —
		// initiating on a still-CONNECTING socket must not silently disable it
	}

	/**
	 * Expects the peer to send a heartbeat within the given time, abandoning the session
	 * otherwise. Meant for the non-initiating side, whose watchdog otherwise only starts
	 * with the first received heartbeat — without this, a peer that completes the
	 * handshake but never sends anything would go undetected.
	 */
	expectHeartbeat(timeoutMs: number) {
		clearTimeout(this.heartbeatReceiveTimeout as any);
		this.heartbeatReceiveTimeout = setTimeout(() => {
			this.debug?.warn("Did not receive the expected heartbeat. Abandoning session.");
			this.abandon("Did not receive the expected heartbeat");
		}, timeoutMs);
	}

	/**
	 * Closes the session immediately when the connection is considered dead, instead of waiting
	 * for the socket's close event: on a black-holed connection the peer never answers the close
	 * handshake, and the close event only arrives once TCP gives up (up to ~15 minutes for a
	 * browser WebSocket) or, with `ws`, once its close timeout (30 s by default) expires.
	 * The socket is terminated where the implementation supports it (Node's `ws`), and closed
	 * otherwise; its late close event no longer affects the session.
	 */
	private abandon(reason: string) {
		if (this.closed) {
			return;
		}
		try {
			if (this.webSocket.terminate) {
				this.webSocket.terminate();
			}
			else {
				this.webSocket.close();
			}
		}
		catch (error) {
			this.debug?.warn("Could not tear down the WebSocket", error);
		}
		// A no-op if tearing down the socket already delivered its close event synchronously
		this.handleClose({type: "abandon", code: 1006, reason});
	}

	private handleAck(frameId: string, payload: string | undefined) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			try {
				const result = payload ? JSON.parse(payload) : undefined;
				promise.resolve(result);
			}
			catch (error) {
				this.debug?.warn("Could not parse ACK payload", payload, error);
				promise.reject(
					new VcmpError({
						title: "Invalid acknowledgement",
						status: 500,
						detail: "The ACK payload could not be parsed.",
						cause: error,
					}),
				);
			}
		}
	}

	private handleNak(frameId: string, payload: string | undefined) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			let error: VcmpError;
			try {
				error = payload ? createVcmpError(JSON.parse(payload)) : new VcmpError({
					title: "Message handling failed",
					status: 500,
					detail: "Unspecified error in message handling.",
				});
			}
			catch (parseError) {
				this.debug?.warn("Could not parse NAK payload", payload, parseError);
				error = new VcmpError({
					title: "Message handling failed",
					status: 500,
					detail: "The NAK payload could not be parsed.",
					cause: parseError,
				});
			}
			promise.reject(error);
		}
	}

	/**
	 * Removes and returns the promise callbacks of a pending message.
	 * Returns undefined if the message is not pending (already settled or unknown).
	 */
	private takePendingMessage(frameId: string) {
		const promise = this.callbacks.get(frameId);
		if (promise) {
			this.callbacks.delete(frameId);
		}
		return promise;
	}

	private failPendingMessage(frameId: string, error: VcmpError) {
		const promise = this.takePendingMessage(frameId);
		if (promise) {
			this.debug?.warn("Failing pending message", frameId, error.detail);
			promise.reject(error);
		}
	}

	private failAllPendingMessages(error: VcmpError) {
		for (const frameId of [...this.callbacks.keys()]) {
			this.failPendingMessage(frameId, error);
		}
	}

	private sendFrame(frame: VcmpFrame) {
		if (this.webSocket) {
			const serializedFrame = serializeVcmpFrame(frame);
			this.debug?.debug("Sending frame", describeVcmpFrame(serializedFrame));
			this.webSocket.send(serializedFrame);
		}
	}

	/**
	 * Sends a frame on a best-effort basis from the inbound message path,
	 * where a send failure must not propagate into the WebSocket's message event.
	 */
	private trySendFrame(frame: VcmpFrame) {
		try {
			this.sendFrame(frame);
		}
		catch (error) {
			this.debug?.warn("Could not send frame", frame.type, error);
		}
	}

	private handleOpen = () => {
		if (this.closed) {
			return;
		}
		this.debug?.debug("WebSocket session open");
		this.awaitingHeartbeat = true;
		// start a heartbeat that was initiated while the socket was still connecting
		if (this.initiatedHeartbeatInterval) {
			this.sendHeartbeat({type: "HBT", heartbeatInterval: this.initiatedHeartbeatInterval});
		}
		// a failing first heartbeat has already abandoned the session and raised onClose
		if (!this.closed) {
			this.onOpen && this.onOpen();
		}
		if (this.clientAuthentication && !this.closed && !this.policyClosing) {
			this.startClientAuthentication(false);
		}
	};

	private handleClose = (event: VcmpCloseEvent) => {
		if (this.closed) {
			// the late close event of an abandoned socket
			return;
		}
		this.closed = true;
		this.debug?.debug("WebSocket session closed", {
			type: event.type,
			code: event.code,
			reason: event.reason,
		});
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout as any);
		}
		if (this.heartbeatReceiveTimeout) {
			clearTimeout(this.heartbeatReceiveTimeout as any);
		}
		this.clearAuthenticationTimers();
		this.heldOutbound = [];
		this.heldInbound = undefined;
		this.failAllPendingMessages(
			new VcmpError({
				title: "Session closed",
				status: 503,
				detail: "The session was closed before the message was acknowledged.",
			}),
		);
		this.onClose && this.onClose();
	};

	private handleError = () => {
		if (this.closed) {
			return;
		}
		this.debug?.warn("WebSocket session error");
		if (this.webSocket) {
			this.webSocket.close();
		}
	};

	private handleMessage = (event: VcmpMessageEvent) => {
		if (this.closed || this.policyClosing) {
			return;
		}
		if (this.heldInbound) {
			// a handshake authentication is running
			this.heldInbound.push(event);
			return;
		}
		if (typeof event.data != "string" && this.serverAuthentication && !this.authenticated) {
			// A binary frame is no VCMP frame: before authentication, only HBT and AUT are accepted
			this.closeForPolicy(AuthenticationCloseReason.REQUIRED);
			return;
		}
		if (typeof event.data == "string") {
			const described = describeVcmpFrame(event.data);
			this.debug?.debug("Received frame", described);
			let frame: ReturnType<typeof parseVcmpFrame>;
			try {
				frame = parseVcmpFrame(event.data);
			}
			catch (error) {
				if (this.serverAuthentication && !this.authenticated) {
					// Before authentication, only HBT and AUT are accepted
					this.debug?.warn("Invalid frame before authentication", described);
					this.closeForPolicy(AuthenticationCloseReason.REQUIRED);
					return;
				}
				// A throw from the message event would be an uncaught exception under Node's
				// `ws` and could take the whole process down. Log and drop the frame instead.
				this.debug?.warn("Ignoring invalid frame", described, error);
				return;
			}
			if (frame.type == "AUT") {
				this.debug?.debug("Parsed frame", {type: frame.type, id: frame.id});
			}
			else {
				this.debug?.debug("Parsed frame", frame);
			}
			if (this.serverAuthentication && !this.authenticated && frame.type != "HBT" && frame.type != "AUT") {
				// Until the session is authenticated, only HBT and AUT are accepted
				this.closeForPolicy(AuthenticationCloseReason.REQUIRED);
				return;
			}
			switch (frame.type) {
				case "HBT":
					this.handleHeartbeatReceived(frame);
					break;

				case "ACK":
					if (frame.id === this.pendingAuthenticationId) {
						this.handleAuthenticationAck(frame.payload);
					}
					else {
						this.handleAck(frame.id, frame.payload);
					}
					break;

				case "NAK":
					if (frame.id === this.pendingAuthenticationId) {
						this.handleAuthenticationNak(frame.payload);
					}
					else {
						this.handleNak(frame.id, frame.payload);
					}
					break;

				case "MSG":
					this.handleVcmpMessage(frame.id, frame.payload);
					break;

				case "AUT":
					this.handleAuthenticationRequest(frame.id, frame.payload);
					break;
			}
		}
	};

	// --- server role ---

	private handleAuthenticationRequest(frameId: string, payload: string | undefined) {
		const serverAuthentication = this.serverAuthentication;
		if (!serverAuthentication) {
			this.debug?.warn("Received AUT on a session that doesn't authenticate, sending NAK");
			this.sendNak(frameId, {
				title: "Authentication not supported",
				status: 400,
				detail: "This endpoint does not authenticate sessions.",
			});
			return;
		}
		if (this.authenticationPending) {
			this.closeForPolicy(AuthenticationCloseReason.CONCURRENT);
			return;
		}
		const first = !this.authenticated;
		const credential = parseCredential(payload);
		if (!credential) {
			this.sendNak(frameId, {
				title: "Invalid credential",
				status: 400,
				detail: "The AUT payload must be a JSON object.",
			});
			if (first) {
				this.closeForPolicy(AuthenticationCloseReason.FAILED);
			}
			return;
		}
		this.authenticationPending = true;
		asyncExecute(async () => {
			try {
				await this.authenticate(serverAuthentication, frameId, credential, first);
			}
			catch (error) {
				// Last line of defence: nothing awaits this callback, so a throw here would be an unhandled
				// rejection, which terminates a Node process by default
				this.debug?.warn("Unexpected error while authenticating a session", describeError(error));
				this.authenticationPending = false;
				if (!this.authenticated) {
					this.closeForPolicy(AuthenticationCloseReason.FAILED);
				}
			}
		});
	}

	/**
	 * Authenticates an AUT and answers it. The session's authenticated state (principal, expiry, cleared
	 * timeout, `onAuthenticated`) is committed only once the ACK is out; any failure before that — the
	 * authenticator's, or one after it accepted (no principal, the principal comparison or the ACK payload
	 * throwing) — fails closed: a NAK, and on the first AUT the session is closed, on a re-authentication the
	 * previous state stays until its expiry.
	 */
	private async authenticate(
		serverAuthentication: VcmpSessionServerAuthentication<P>,
		frameId: string,
		credential: VcmpCredential,
		first: boolean,
	) {
		const fail = (problem: ProblemDetail, closeReason: string = AuthenticationCloseReason.FAILED) => {
			this.authenticationPending = false;
			if (this.closed || this.policyClosing) {
				return;
			}
			this.sendNak(frameId, problem);
			if (first || closeReason == AuthenticationCloseReason.PRINCIPAL_CHANGED) {
				this.closeForPolicy(closeReason);
			}
			// a failed re-authentication keeps the session until its current expiry
		};

		let authentication: VcmpAuthentication<P>;
		try {
			authentication = await serverAuthentication.authenticate(credential);
		}
		catch (error) {
			this.debug?.info("Authentication failed", describeError(error));
			fail(rejectionProblem(error));
			return;
		}
		if (this.closed || this.policyClosing) {
			this.authenticationPending = false;
			return;
		}

		// Everything that can fail after the authenticator accepted, before any state changes
		let expiresIn: number | undefined;
		let ack: VcmpAuthenticationAck;
		let ackPayload: string | undefined;
		try {
			if (!isValidAuthentication(authentication)) {
				throw new Error("The authenticator returned no principal or an invalid authentication.");
			}
			// Computed once: the expiry decided on here is the one sent in the ACK
			expiresIn = expiresInOf(authentication.expiresAt);
			if (expiresIn !== undefined && expiresIn <= 0) {
				// An expiry that is already over: the credential is rejected, never acknowledged with expiresIn 0
				this.debug?.info("Authentication failed: the credential has expired");
				fail(EXPIRED_CREDENTIAL);
				return;
			}
			if (
				!first
				&& !serverAuthentication.principalEquals(this.authenticatedPrincipal as P, authentication.principal)
			) {
				// A session never changes identity
				fail({
					title: "Principal changed",
					status: 403,
					detail: "A session cannot be re-authenticated as another principal.",
				}, AuthenticationCloseReason.PRINCIPAL_CHANGED);
				return;
			}
			ack = {...authentication.ack};
			delete ack.expiresIn;
			if (expiresIn !== undefined) {
				ack.expiresIn = expiresIn;
			}
			ackPayload = Object.keys(ack).length > 0 ? JSON.stringify(ack) : undefined;
		}
		catch (error) {
			this.debug?.warn("Could not complete an accepted authentication", describeError(error));
			fail(UNEXPECTED_FAILURE);
			return;
		}

		// Commit and send the ACK in one synchronous step: nothing can arrive in between, except from a
		// synchronously delivering socket, which then already sees the authenticated session
		const authenticatedBefore = this.authenticated;
		const principalBefore = this.authenticatedPrincipal;
		this.authenticated = true;
		this.authenticatedPrincipal = authentication.principal;
		try {
			this.sendFrame({type: "ACK", id: frameId, payload: ackPayload});
		}
		catch (error) {
			this.authenticated = authenticatedBefore;
			this.authenticatedPrincipal = principalBefore;
			this.debug?.warn("Could not send the authentication ACK", error);
			this.authenticationPending = false;
			if (first) {
				this.closeForPolicy(AuthenticationCloseReason.FAILED);
			}
			return;
		}
		this.authenticationPending = false;
		this.authenticationTimeout?.clear();
		this.armExpiry(expiresIn);
		this.raiseAuthenticated({source: "aut", reauthentication: !first, ack});
	}

	private sendNak(frameId: string, problem: ProblemDetail) {
		this.trySendFrame({type: "NAK", id: frameId, payload: JSON.stringify(problem)});
	}

	private raiseAuthenticated(event: VcmpAuthenticatedEvent) {
		try {
			this.onAuthenticated?.(event);
		}
		catch (error) {
			// raised from an asynchronous path, where a throw would be an unhandled rejection
			this.debug?.warn("Error in authentication handler", error);
		}
	}

	// --- client role ---

	/**
	 * One authentication attempt: obtaining the credential, sending the AUT and waiting for the answer. The
	 * answer timeout starts when the credential is requested, so a provider that never completes ends like an
	 * unanswered AUT. The attempt ends exactly once: with the answer, a failure, or the timeout.
	 */
	private startClientAuthentication(refresh: boolean) {
		const clientAuthentication = this.clientAuthentication;
		if (!clientAuthentication || this.authenticationPending) {
			return;
		}
		const attempt = {};
		this.currentAttempt = attempt;
		this.authenticationPending = true;
		this.pendingAuthenticationIsRefresh = refresh;
		const isCurrent = () => this.currentAttempt === attempt && !this.closed && !this.policyClosing;
		const end = () => {
			clearTimeout(this.answerTimeout as any);
			this.currentAttempt = undefined;
			this.pendingAuthenticationId = undefined;
			this.authenticationPending = false;
		};
		const failCredential = (error: VcmpError) => {
			end();
			this.clientAuthenticationFailed(error, refresh, "credential");
		};

		this.answerTimeout = setTimeout(() => {
			if (!isCurrent()) {
				return;
			}
			end();
			this.clientAuthenticationFailed(
				authenticationError(504, "Authentication timeout", "The authentication was not answered in time."),
				refresh,
				"timeout",
			);
		}, clientAuthentication.timeout);

		asyncExecute(async () => {
			let credential: unknown;
			try {
				credential = await clientAuthentication.authenticate();
			}
			catch (error) {
				if (isCurrent()) {
					failCredential(
						authenticationError(500, "Credential unavailable", "The credential provider failed.", error),
					);
				}
				return;
			}
			if (!isCurrent()) {
				return;
			}
			if (!isCredential(credential)) {
				failCredential(
					authenticationError(500, "Invalid credential", "The credential provider must return an object."),
				);
				return;
			}
			let payload: string;
			try {
				payload = JSON.stringify(credential);
			}
			catch {
				failCredential(
					authenticationError(500, "Invalid credential", "The credential could not be serialized."),
				);
				return;
			}
			const id = generateVcmpFrameId();
			// Set before sending: a synchronously delivering socket can deliver the answer during sendFrame
			this.pendingAuthenticationId = id;
			try {
				this.sendFrame({type: "AUT", id, payload});
			}
			catch (error) {
				if (isCurrent()) {
					failCredential(
						authenticationError(503, "Send failed", "The authentication could not be sent.", error),
					);
				}
			}
		});
	}

	private endClientAttempt() {
		clearTimeout(this.answerTimeout as any);
		this.currentAttempt = undefined;
		this.pendingAuthenticationId = undefined;
		this.authenticationPending = false;
	}

	private handleAuthenticationAck(payload: string | undefined) {
		this.endClientAttempt();
		let ack: VcmpAuthenticationAck = {};
		if (payload) {
			try {
				const parsed = JSON.parse(payload);
				if (isCredential(parsed)) {
					ack = parsed;
				}
				else {
					this.debug?.warn("Ignoring an authentication ACK payload that is not an object");
				}
			}
			catch (error) {
				this.debug?.warn("Could not parse the authentication ACK payload", error);
			}
		}
		if (ack.expiresIn !== undefined && !(Number.isInteger(ack.expiresIn) && ack.expiresIn >= 0)) {
			this.debug?.warn("Ignoring an invalid expiresIn", ack.expiresIn);
			delete ack.expiresIn;
		}
		const first = !this.authenticated;
		this.authenticated = true;
		this.authenticationAck = ack;
		this.scheduleRefresh(ack.expiresIn);
		if (first) {
			this.releaseHeldOutbound();
		}
		this.raiseAuthenticated({source: "aut", reauthentication: !first, ack});
	}

	private handleAuthenticationNak(payload: string | undefined) {
		this.endClientAttempt();
		let error: VcmpError;
		try {
			error = payload
				? createVcmpError(JSON.parse(payload))
				: authenticationError(401, "Authentication failed", "The server rejected the authentication.");
		}
		catch (parseError) {
			error = authenticationError(
				401,
				"Authentication failed",
				"The server rejected the authentication; its NAK payload could not be parsed.",
				parseError,
			);
		}
		this.clientAuthenticationFailed(error, this.pendingAuthenticationIsRefresh, "nak");
	}

	/**
	 * @param failure `timeout`: no answer (or no credential) in time — the server may still be processing the
	 * AUT, so another one on this session would be concurrent, which the server closes the session for;
	 * `credential`: the provider failed or its credential is unusable; `nak`: the server rejected it.
	 */
	private clientAuthenticationFailed(error: VcmpError, refresh: boolean, failure: "nak" | "timeout" | "credential") {
		this.debug?.warn("Authentication failed", error.status, error.title);
		try {
			this.onAuthenticationError?.(error);
		}
		catch (handlerError) {
			this.debug?.warn("Error in authentication error handler", handlerError);
		}
		if (failure == "timeout") {
			// Neither a first authentication nor a refresh can be retried on this session: close it, so that
			// the client reconnects with a fresh credential
			this.closeForPolicy(AuthenticationCloseReason.TIMEOUT);
			return;
		}
		if (failure == "credential" || !refresh) {
			// The session is unusable: close it, so that the client reconnects with a fresh credential
			this.closeForPolicy(AuthenticationCloseReason.FAILED);
			return;
		}
		// A refresh answered with NAK: retry until the expiry; after it, the server closes the session and the
		// client reconnects. After a NAK 403 for another principal the server closes the session right away,
		// which cancels the retry.
		const retryDelay = this.clientAuthentication?.refreshRetryDelay ?? 0;
		if (this.expiresAt !== undefined && Date.now() + retryDelay < this.expiresAt) {
			this.refreshTimeout?.clear();
			this.refreshTimeout = setLongTimeout(() => this.startClientAuthentication(true), retryDelay);
		}
	}

	private scheduleRefresh(expiresIn: number | undefined) {
		this.refreshTimeout?.clear();
		this.refreshTimeout = undefined;
		if (expiresIn === undefined) {
			this.expiresAt = undefined;
			return;
		}
		this.expiresAt = Date.now() + expiresIn;
		const delay = computeRefreshDelay(expiresIn, this.clientAuthentication?.refreshLeadTime);
		this.refreshTimeout = setLongTimeout(() => this.startClientAuthentication(true), delay);
	}

	private releaseHeldOutbound() {
		const held = this.heldOutbound;
		this.heldOutbound = [];
		for (const frame of held) {
			if (this.closed || this.policyClosing) {
				// the remaining sends are rejected by the close
				return;
			}
			try {
				this.sendFrame(frame);
			}
			catch (error) {
				const promise = this.takePendingMessage(frame.id);
				promise?.reject(
					new VcmpError({
						title: "Send failed",
						status: 503,
						detail: "The message could not be sent.",
						cause: error,
					}),
				);
			}
		}
	}

	private sendHeartbeat(frame: VcmpHeartbeatFrame) {
		// Never send or arm the watchdog on a session that is not open — otherwise the
		// watchdog would close a healthy connection whose heartbeat was never actually
		// sent. Mirrors the Java implementation (vcmp-spring).
		if (!this.isOpen) {
			this.debug?.warn("Not sending heartbeat: the WebSocket is not open.");
			return;
		}

		this.debug?.debug("Sending heartbeat.");

		// set the flag that we await a heartbeat
		this.awaitingHeartbeat = true;

		try {
			this.sendFrame(frame);
		}
		catch (error) {
			// The connection is in an uncertain state — abandon it, which settles all
			// pending sends via the close path. Mirrors the Java implementation.
			this.debug?.warn("Could not send heartbeat. Abandoning session.", error);
			this.abandon("Could not send heartbeat");
			return;
		}

		// Arm the watchdog after a successful send: if the peer never sends a heartbeat
		// back within 2 x interval, the connection is considered dead and abandoned. This
		// also covers a peer that connects but never answers the initial heartbeat at all.
		clearTimeout(this.heartbeatReceiveTimeout as any);
		this.heartbeatReceiveTimeout = setTimeout(() => {
			this.debug?.warn("Did not receive heartbeat in time. Abandoning session.");
			this.abandon("Did not receive heartbeat in time");
		}, 2 * frame.heartbeatInterval);
	}

	private handleHeartbeatReceived(frame: VcmpHeartbeatFrame) {
		// Guard against a malformed HBT frame: a missing or garbled interval parses to
		// NaN, and NaN timeouts coerce to 0 — which would echo "HBTNaN" and let the
		// watchdog close the session within the same tick.
		if (!Number.isFinite(frame.heartbeatInterval) || frame.heartbeatInterval <= 0) {
			this.debug?.warn("Ignoring heartbeat with invalid interval", frame.heartbeatInterval);
			return;
		}
		// check whether we are currently awaiting a heartbeat
		if (this.awaitingHeartbeat) {
			// clear the flag that we are awaiting a heartbeat
			this.awaitingHeartbeat = false;

			this.debug?.debug("Received heartbeat.");

			// clear the heartbeat receive timeout
			clearTimeout(this.heartbeatReceiveTimeout as any);

			// send heartbeat after the interval passes
			this.heartbeatTimeout = setTimeout(() => this.sendHeartbeat(frame), frame.heartbeatInterval);
		}
		else {
			this.debug?.warn("Ignoring unexpected heartbeat.");
		}
	}

	private handleVcmpMessage(frameId: string, payload: string | undefined) {
		let message: any;
		try {
			message = payload ? JSON.parse(payload) : {};
		}
		catch (error) {
			// NAK the frame so the peer's send() settles instead of pending forever.
			this.debug?.warn("Could not parse message payload, sending NAK", payload, error);
			this.trySendFrame({
				type: "NAK",
				id: frameId,
				payload: JSON.stringify(
					new VcmpError({
						title: "Invalid message",
						status: 400,
						detail: "The message payload could not be parsed.",
					}),
				),
			});
			return;
		}
		const type = message["@type"];
		if (type) {
			const handler = this.resolver(type);
			if (handler) {
				asyncExecute(async () => {
					try {
						const result = await handler(message, this);
						this.trySendFrame({
							type: "ACK",
							id: frameId,
							payload: result !== undefined ? JSON.stringify(result) : undefined,
						});
					}
					catch (error) {
						this.debug?.warn("Error in handler, sending NAK", error);
						// Serializing the handler's error can itself throw (circular
						// references, BigInt); nothing awaits this callback, so a throw
						// here would be an unhandled promise rejection.
						let nakPayload: string;
						try {
							nakPayload = JSON.stringify(createVcmpError(error));
						}
						catch (serializationError) {
							this.debug?.warn("Could not serialize handler error", serializationError);
							nakPayload = JSON.stringify(
								new VcmpError({
									title: "Message handling failed",
									status: 500,
									detail: "The handler error could not be serialized.",
								}),
							);
						}
						this.trySendFrame({type: "NAK", id: frameId, payload: nakPayload});
					}
				});
			}
			else {
				this.debug?.warn("No handler found for message, sending NAK", message);
				this.trySendFrame({type: "NAK", id: frameId});
			}
		}
		else {
			this.debug?.error("Could not determine type of message, sending NAK", message);
			this.trySendFrame({
				type: "NAK",
				id: frameId,
				payload: JSON.stringify(
					new VcmpError({
						title: "Invalid message",
						status: 400,
						detail: "The message does not specify a type.",
					}),
				),
			});
		}
	}
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
	return typeof value == "object" && value !== null && typeof (value as any).then == "function";
}

function isValidAuthentication(value: unknown): value is VcmpAuthentication<unknown> {
	if (typeof value != "object" || value === null) {
		return false;
	}
	const {principal} = value as VcmpAuthentication<unknown>;
	if (principal === undefined || principal === null) {
		// an authentication without a principal is a failure, never an authenticated session
		return false;
	}
	const {expiresAt, ack} = value as VcmpAuthentication<unknown>;
	if (expiresAt !== undefined && !(expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()))) {
		return false;
	}
	return ack === undefined || isCredential(ack);
}

function parseCredential(payload: string | undefined) {
	if (!payload) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(payload);
		return isCredential(parsed) ? parsed : undefined;
	}
	catch {
		return undefined;
	}
}

/**
 * The NAK for a failed authentication: a rejection (a problem detail with status 400, 401 or 403) is passed
 * on; anything else is an unexpected failure of the authenticator and becomes a 500, without its message.
 */
function rejectionProblem(error: unknown): ProblemDetail {
	if (isProblemDetail(error) && [400, 401, 403].includes(error.status)) {
		const {title, status, type, instance, detail} = error;
		return {title, status, type, instance, detail};
	}
	return UNEXPECTED_FAILURE;
}

/**
 * Describes an error of an application's authenticator for debug output: by type and message (keeping
 * credentials out of its messages is the application's responsibility). The library's own parse errors,
 * which quote their input, are never passed here.
 */
function describeError(error: unknown) {
	if (isProblemDetail(error)) {
		return `${error.status} ${error.title}`;
	}
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`;
	}
	return typeof error;
}

const UNEXPECTED_FAILURE: ProblemDetail = {
	title: "Authentication failed",
	status: 500,
	detail: "The authenticator failed unexpectedly.",
};

const EXPIRED_CREDENTIAL: ProblemDetail = {
	title: "Credential expired",
	status: 401,
	detail: "The credential has expired.",
};

/**
 * Milliseconds from now until an authenticator's expiry, `undefined` without expiry. Not clamped: a value
 * ≤ 0 means the expiry is already over (`Date` has whole milliseconds, so the value is an integer).
 */
function expiresInOf(expiresAt: Date | undefined) {
	return expiresAt === undefined ? undefined : expiresAt.getTime() - Date.now();
}
