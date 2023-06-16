import {getRandomBytesBase64} from "./random.js";

/**
 * Generates a random number of `entropyBytes` length and encodes
 * it Base64 url-safe.
 *
 * This result is not intended to be base64-decoded since the padding
 * is omitted (for `entropyBytes` not divisible by 3) and the definition
 * for url-safe encoding may vary.
 *
 * @param entropyBytes The length in bytes of the random number.
 * @returns A random url-safe Base64-encoded id.
 */
export function generateRandomId(entropyBytes: number) {
    return escape(getRandomBytesBase64(entropyBytes));
}

function escape(str: string) {
    return str.replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
}