import * as crypto from "crypto";

/**
 * Get random bytes (node version).
 * @param byteCount
 */
export function getRandomBytesBase64(byteCount: number) {
    return crypto.randomBytes(byteCount).toString("base64");
}
