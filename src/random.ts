import * as crypto from "crypto";

/**
 * Get random bytes (node version).
 * @param length
 */
export function getRandomBytes(length: number) {
    return crypto.randomBytes(length);
}
