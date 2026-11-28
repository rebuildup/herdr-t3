/**
 * Bytes for a `*.wasm?url` asset (ADR-0025 artifacts: ghostty-vt.wasm,
 * terminal-input.wasm).
 *
 * Three delivery shapes exist:
 * - `data:` URI — the historical vite `assetsInlineLimit` inline. Kept as
 *   the decode path so older bundles/tests keep working.
 * - http(s) — vite dev server and the browser dev fallback: plain fetch.
 * - file:// — the packaged app (and `electron .` on a built dist/) loads
 *   dist/ over file://, where fetch() is refused. The Electron main
 *   process serves the asset over IPC (`herdr-t3:asset`, preload
 *   `herdrT3.readAsset`) instead.
 *
 * Keeping the wasm out of the JS bundle matters for the spawn->operable
 * contract: the base64 data URI used to be ~1.7 MB of the entry chunk,
 * which V8 had to fetch, parse and compile before any module code ran.
 */

interface AssetBridge {
  readAsset?(urlPath: string): Promise<unknown>;
}

/** `data:<mime>;base64,<payload>` -> bytes; throws on any other data: shape */
export function decodeDataUri(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!meta.endsWith(";base64")) throw new Error(`wasm asset: unsupported data URI (${meta})`);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("wasm asset: IPC returned an unexpected payload");
}

export async function wasmAssetBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) return decodeDataUri(url);
  const bridge = (globalThis as { herdrT3?: AssetBridge }).herdrT3;
  if (
    bridge?.readAsset &&
    typeof location !== "undefined" &&
    location.protocol === "file:"
  ) {
    // Built bundles reference assets as `new URL("x.wasm", import.meta.url)`
    // — an absolute file:// URL. The main process maps it back into dist/.
    let assetPath = url;
    if (url.startsWith("file:")) {
      assetPath = decodeURIComponent(new URL(url).pathname);
      // Windows file URLs arrive as "/C:/…" — drop the phantom slash.
      if (/^\/[A-Za-z]:\//.test(assetPath)) assetPath = assetPath.slice(1);
    }
    return toBytes(await bridge.readAsset(assetPath));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`wasm asset ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
