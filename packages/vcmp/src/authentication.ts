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
	/** `false` for the authentication that makes the session usable, `true` for each refresh after it. */
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
	/** Provides the credential; called on every connect and for every refresh. */
	authenticate(): Promise<object> | object;
	/** Time in milliseconds within which the server must answer an `AUT`. */
	timeout: number;
	/**
	 * How long before the expiry the session re-authenticates, in milliseconds, either fixed or computed
	 * from the `ACK`'s `expiresIn`. Default: `min(60 s, 20 % of expiresIn)`. Bounded, see
	 * {@link computeRefreshDelay}.
	 */
	refreshLeadTime?: number | ((expiresIn: number) => number);
	/** Delay in milliseconds before retrying a failed refresh; retried only while before the expiry. */
	refreshRetryDelay: number;
}

export const DEFAULT_AUTHENTICATION_TIMEOUT = 10000;
export const DEFAULT_REFRESH_RETRY_DELAY = 5000;

/** The default refresh lead time: `min(60 s, 20 % of expiresIn)`. */
export function defaultRefreshLeadTime(expiresIn: number) {
	return Math.min(60000, 0.2 * expiresIn);
}

/** A refresh is never sent sooner than this after the ACK that scheduled it. */
export const MIN_REFRESH_DELAY = 1000;

/**
 * The delay from receiving an ACK with `expiresIn` until the refresh: `expiresIn` minus the effective lead
 * time, `min(lead time, expiresIn / 2)` (the default lead time if the configured one isn't a finite number
 * ≥ 0, or its function throws), but at least {@link MIN_REFRESH_DELAY}, so that no lead time or tiny `expiresIn` causes a tight
 * refresh loop.
 */
export function computeRefreshDelay(
	expiresIn: number,
	refreshLeadTime?: number | ((expiresIn: number) => number),
) {
	let configured: unknown = refreshLeadTime;
	if (typeof refreshLeadTime == "function") {
		try {
			configured = refreshLeadTime(expiresIn);
		}
		catch {
			// an application's function must not break the session: it runs from the socket's message event
			configured = undefined;
		}
	}
	const leadTime = typeof configured == "number" && Number.isFinite(configured) && configured >= 0
		? configured
		: defaultRefreshLeadTime(expiresIn);
	return Math.max(MIN_REFRESH_DELAY, expiresIn - Math.min(leadTime, expiresIn / 2));
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
