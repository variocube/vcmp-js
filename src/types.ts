import {VcmpSession} from "./session";

export type VcmpHandler<T> = (message: T, session: VcmpSession) => Promise<void> | void;
export type OpenHandler = () => any;
export type CloseHandler = () => any;

export interface VcmpMessage {
    "@type": string;
}

export interface ConsoleLike {
    info(...data: any[]): void;

    debug(...data: any[]): void;

    warn(...data: any[]): void;

    error(...data: any[]): void;
}