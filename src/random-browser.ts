/**
 * Get random bytes (browser version).
 * @param length
 */
export function getRandomBytes(length: number) {
    const bytes = new Uint8Array(9);
    return Buffer.from(crypto.getRandomValues(bytes));
}
