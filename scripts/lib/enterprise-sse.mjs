// SPDX-License-Identifier: Apache-2.0
export async function readSsePage(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("SSE cursor timed out")), 10_000);
    timer.unref?.();
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) throw new Error("SSE ended without a cursor");
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error("SSE fixture page exceeded its size limit");
      text += decoder.decode(value, { stream: true });
      const cursor = /(?:^|\n)event: cursor\r?\n[^]*?\r?\n\r?\n/u.exec(text);
      if (cursor) return text.slice(0, cursor.index + cursor[0].length);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
}
