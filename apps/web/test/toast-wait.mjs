// Sonner mounts a toast on a timer and removes a dismissed one after its
// exit, so a test waits for the toast it expects (or for it to go).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function toastShown(act, selector = ".fdy-toast") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (document.querySelector(selector)) return;
    await act(() => sleep(25));
  }
}

export async function toastGone(act, selector = ".fdy-toast") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!document.querySelector(selector)) return;
    await act(() => sleep(25));
  }
}
