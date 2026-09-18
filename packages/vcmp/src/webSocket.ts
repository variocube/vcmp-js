/**
 * The subset of the WebSocket contract this library actually uses, declared structurally so that
 * neither the DOM's `WebSocket` nor Node's `ws` types appear in the emitted declarations.
 *
 * Referencing `ws` from the public API would force every consumer to resolve those types, and
 * `@types/ws` opens with `/// <reference types="node" />` — which pulls Node's globals into a
 * browser-only project and lets `process`, `Buffer` and Node's `setTimeout` overloads type-check
 * in code that runs in a browser. Both the DOM `WebSocket` and `ws` satisfy the interfaces below,
 * as does an in-memory test double.
 */
export interface VcmpWebSocket {
	/** `0` CONNECTING, `1` OPEN, `2` CLOSING, `3` CLOSED. */
	readonly readyState: number;

	// The event parameters are `any` on purpose: the DOM and `ws` declare incompatible event types
	// for these properties, and a narrower parameter here would make one of them unassignable.
	// The handlers this library installs annotate their own parameters (see the event types below).
	onopen: ((event: any) => void) | null;
	onerror: ((event: any) => void) | null;
	onclose: ((event: any) => void) | null;
	onmessage: ((event: any) => void) | null;

	send(data: string): void;

	close(): void;
}

/**
 * A WebSocket implementation that can be constructed from a URL, such as the DOM's `WebSocket` or
 * the class exported by the `ws` package.
 */
export interface VcmpWebSocketConstructor {
	new(url: string): VcmpWebSocket;
}

/** The part of a message event this library reads. */
export interface VcmpMessageEvent {
	readonly data: unknown;
}

/** The part of a close event this library reads. */
export interface VcmpCloseEvent {
	readonly type: string;
	readonly code: number;
	readonly reason: string;
}
