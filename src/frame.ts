import {generateRandomId} from "./generateRandomId.js";

const ID_LENGTH = 12;
const ID_INDEX = 3;

const PAYLOAD_INDEX = ID_INDEX + ID_LENGTH;

export enum VcmpFrameType {
    ACK = "ACK",
    NAK = "NAK",
    MSG = "MSG",
    HBT = "HBT"
}

interface VcmpHeartbeatFrame {
    type: VcmpFrameType.HBT;
    heartbeatInterval: number;
}

interface VcmpAckFrame {
    type: VcmpFrameType.ACK;
    id: string;
}

interface VcmpNakFrame {
    type: VcmpFrameType.NAK;
    id: string;
}

interface VcmpMessageFrame {
    type: VcmpFrameType.MSG;
    id: string;
    payload: string;
}

export type VcmpFrame = VcmpHeartbeatFrame|VcmpAckFrame|VcmpNakFrame|VcmpMessageFrame;

export function parseVcmpFrame(raw: string) {
    const type = raw.substr(0, 3);
    switch (type) {
        case VcmpFrameType.ACK:
        case VcmpFrameType.NAK:
            return {
                type,
                id: raw.substr(3)
            };
        case VcmpFrameType.MSG:
            return {
                type,
                id: raw.substr(ID_INDEX, ID_LENGTH),
                payload: raw.substr(PAYLOAD_INDEX)
            };
        case VcmpFrameType.HBT:
            return {
                type,
                heartbeatInterval: Number.parseInt(raw.substr(3))
            };
        default:
            throw new Error("Invalid message type: " + type);
    }
}

export function serializeVcmpFrame(frame: VcmpFrame) {
    switch (frame.type) {
        case VcmpFrameType.ACK:
        case VcmpFrameType.NAK:
            return `${frame.type}${frame.id}`;

        case VcmpFrameType.MSG:
            return `${frame.type}${frame.id}${frame.payload}`;

        case VcmpFrameType.HBT:
            return `${frame.type}${frame.heartbeatInterval}`;

        default:
            throw new Error("Invalid message type");
    }
}

export function generateVcmpFrameId() {
    return generateRandomId(9);
}

