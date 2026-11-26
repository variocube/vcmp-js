import {VcmpError} from "./error";

/** The credential of an `AUT` frame: a JSON object whose shape the endpoint defines. */
export type VcmpCredential = Record<string, unknown>;

/**
 * The payload of the `ACK` to an `AUT`. The protocol reserves only `expiresIn`: the milliseconds,
 * counted from sending the `ACK`, after which the session's authentication expires (absent: it doesn't).
 * All other members are defined by the endpoint, e.g. what the session is authenticated as.
 */
export interface VcmpAuthenticationAck {
	expiresIn?: number;

	[member: string]: unknown;
}

/** How a server session was authenticated: by its handshake (transition mode) or by an `AUT` frame. */
export type VcmpAuthenticationSource = "handshake" | "aut";

/** Raised on every successful authentication of a session, first or re-authentication. */
export interface VcmpAuthenticatedEvent {
	source: VcmpAuthenticationSource;
	/** `false` for the authentication that makes the session usable, `true` for each re-authentication after it. */
	reauthentication: boolean;
	/** The `ACK` payload (received by a client, sent by a server); empty for a handshake authentication. */
	ack: VcmpAuthenticationAck;
}

/** The successful result of a server-side authenticator. */
export interface VcmpAuthentication<P> {
	/** What the session is authenticated as; available as `session.principal`. */
	principal: P;
	/** When the authentication expires (e.g. a JWT's `exp`); absent: it doesn't. */
	expiresAt?: Date;
	/** Endpoint-defined members of the `ACK` payload. `expiresIn` is reserved and set by the library. */
	ack?: Record<string, unknown>;
}

/** Server role of a session: the endpoint requires authentication. */
export interface VcmpSessionServerAuthentication<P> {
	/**
	 * Authenticates an `AUT` credential. Returns the principal (optionally with an expiry) or throws to
	 * reject: a `VcmpError`/problem detail with status 400, 401 or 403 is answered with that status,
	 * anything else (an unexpected failure) with a `NAK` 500.
	 */
	authenticate(credential: VcmpCredential): VcmpAuthentication<P> | Promise<VcmpAuthentication<P>>;
	/** Time in milliseconds from connect within which the session must be authenticated. */
	timeout: number;
	/** Whether a re-authentication's principal is the session's principal. */
	principalEquals(a: P, b: P): boolean;
}

/** Client role of a session: the session authenticates with an `AUT` frame once its socket opens. */
export interface VcmpSessionClientAuthentication {
	/** Provides the credential; called on every connect and on every `reauthenticate()`. */
	authenticate(): Promise<object> | object;
	/**
	 * Time in milliseconds, from requesting the credential, within which the credential must be provided and the
	 * server must answer the `AUT`. At least {@link MIN_AUTHENTICATION_TIMEOUT}.
	 */
	timeout: number;
}

export const DEFAULT_AUTHENTICATION_TIMEOUT = 10000;

/** The least answer timeout; a smaller one is rejected (not clamped). */
export const MIN_AUTHENTICATION_TIMEOUT = 1000;

/** Rejects an answer timeout below {@link MIN_AUTHENTICATION_TIMEOUT} (or not a finite number). */
export function validateAuthenticationTimeout(timeout: number) {
	if (!(Number.isFinite(timeout) && timeout >= MIN_AUTHENTICATION_TIMEOUT)) {
		throw new RangeError(
			`authenticationTimeout must be at least ${MIN_AUTHENTICATION_TIMEOUT} ms, was ${timeout}.`,
		);
	}
}

/** Close code of a session the server closes for an authentication reason (policy violation). */
export const AUTHENTICATION_CLOSE_CODE = 1008;

/**
 * Close code of a session the client closes for an authentication reason: browsers only let a client close
 * with 1000 or 3000–4999, so clients use 4008, which peers treat like 1008.
 */
export const CLIENT_AUTHENTICATION_CLOSE_CODE = 4008;

/** Informative close reasons; peers don't compare them. */
export const AuthenticationCloseReason = {
	REQUIRED: "authentication required",
	TIMEOUT: "authentication timeout",
	FAILED: "authentication failed",
	EXPIRED: "authentication expired",
	PRINCIPAL_CHANGED: "principal changed",
	CONCURRENT: "concurrent authentication",
} as const;

export function isCredential(value: unknown): value is VcmpCredential {
	return typeof value == "object" && value !== null && !Array.isArray(value);
}

export function authenticationError(status: number, title: string, detail: string, cause?: unknown) {
	return new VcmpError({title, status, detail, ...(cause !== undefined ? {cause} : {})});
}
