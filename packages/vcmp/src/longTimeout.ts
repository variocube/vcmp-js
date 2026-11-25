/** The largest delay `setTimeout` honours; a larger one fires immediately. */
const MAX_TIMEOUT = 2147483647;

export interface LongTimeout {
	clear(): void;
}

/**
 * Like `setTimeout`, but for delays beyond ~24.8 days (e.g. a long-lived authentication's expiry),
 * which `setTimeout` would otherwise fire right away.
 */
export function setLongTimeout(callback: () => void, delay: number): LongTimeout {
	let handle: ReturnType<typeof setTimeout>;
	const due = Date.now() + delay;
	const schedule = (remaining: number) => {
		handle = setTimeout(() => {
			const left = due - Date.now();
			if (left > 0) {
				schedule(left);
			}
			else {
				callback();
			}
		}, Math.min(Math.max(remaining, 0), MAX_TIMEOUT));
	};
	schedule(delay);
	return {clear: () => clearTimeout(handle)};
}
