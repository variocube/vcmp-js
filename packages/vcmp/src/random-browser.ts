/**
 * Get random bytes (browser version).
 * @param byteCount
 */
export function getRandomBytesBase64(byteCount: number) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
}
