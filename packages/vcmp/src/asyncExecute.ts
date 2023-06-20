/**
 * Detects the best way to schedule async execution of a small task.
 */
function detectAsyncExecute() {
    if (typeof queueMicrotask == "function") {
        return queueMicrotask;
    }
    else if (typeof setImmediate == "function") {
        return setImmediate;
    }
    else {
        return (callback: VoidFunction) => Promise.resolve().then(callback);
    }
}

export const asyncExecute = detectAsyncExecute();
