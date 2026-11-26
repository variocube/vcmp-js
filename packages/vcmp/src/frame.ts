import {generateRandomId} from "./generateRandomId";

const TYPE_LENGTH = 3;
const ID_LENGTH = 12;

const ID_INDEX = TYPE_LENGTH;
const HBT_INTERVAL_INDEX = TYPE_LENGTH;

const PAYLOAD_INDEX = ID_INDEX + ID_LENGTH;

export type VcmpFrameType = "ACK" | "NAK" | "MSG" | "HBT" | "AUT";

export interface VcmpHeartbeatFrame {
	type: "HBT";
	heartbeatInterval: number;
}

export interface VcmpAckFrame {
	type: "ACK";
	id: string;
	payload?: string;
}

export interface VcmpNakFrame {
	type: "NAK";
	id: string;
	payload?: string;
}

export interface VcmpMessageFrame {
	type: "MSG";
	id: string;
	payload: string;
}

/**
 * Client → server: authenticates the session. The payload is a JSON object whose shape the endpoint
 * defines (the credential). An `AUT` is not a message: it is never dispatched to message handlers,
 * and its payload is never written to debug output (see {@link describeVcmpFrame}).
 */
export interface VcmpAuthFrame {
	type: "AUT";
	id: string;
	payload?: string;
}

export type VcmpFrame = VcmpHeartbeatFrame | VcmpAckFrame | VcmpNakFrame | VcmpMessageFrame | VcmpAuthFrame;

export function parseVcmpFrame(raw: string) {
	const type = raw.slice(0, 3);
	switch (type) {
		case "ACK":
		case "NAK":
		case "MSG":
		case "AUT":
			return {
				type,
				id: raw.slice(ID_INDEX, PAYLOAD_INDEX),
				payload: raw.slice(PAYLOAD_INDEX) || undefined,
			};
		case "HBT":
			return {
				type,
				heartbeatInterval: Number.parseInt(raw.slice(HBT_INTERVAL_INDEX)),
			};
		default:
			throw new Error("Invalid message type: " + type);
	}
}

export function serializeVcmpFrame(frame: VcmpFrame) {
	switch (frame.type) {
		case "ACK":
		case "NAK":
			return `${frame.type}${frame.id}${frame.payload ? frame.payload : ""}`;

		case "MSG":
			return `${frame.type}${frame.id}${frame.payload}`;

		case "AUT":
			return `${frame.type}${frame.id}${frame.payload ?? ""}`;

		case "HBT":
			return `${frame.type}${frame.heartbeatInterval}`;

		default:
			throw new Error("Invalid message type");
	}
}

/**
 * Describes a raw frame for debug output: an `AUT` frame's payload is the credential and is replaced
 * by `[redacted]`; every other frame is returned unchanged.
 */
export function describeVcmpFrame(raw: string) {
	if (raw.startsWith("AUT")) {
		return raw.slice(0, PAYLOAD_INDEX) + (raw.length > PAYLOAD_INDEX ? "[redacted]" : "");
	}
	return raw;
}

export function generateVcmpFrameId() {
	return generateRandomId(9);
}
