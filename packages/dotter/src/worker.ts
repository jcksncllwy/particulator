// Module worker: decode + stipple off the main thread. Spawned by stippleUrl.
import { stippleUrlHere, type WorkerRequest, type WorkerResponse } from "./decode";

const scope = self as unknown as {
  addEventListener(type: "message", fn: (ev: MessageEvent<WorkerRequest>) => void): void;
  postMessage(msg: WorkerResponse, opts?: { transfer?: Transferable[] }): void;
};

scope.addEventListener("message", async (ev) => {
  const { id, url, opts } = ev.data;
  try {
    const cloud = await stippleUrlHere(url, opts);
    const transfer: Transferable[] = [cloud.data.buffer];
    if (cloud.colors) transfer.push(cloud.colors.buffer);
    scope.postMessage({ id, cloud }, { transfer });
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
