interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The single VS Code webview API handle for posting messages to the host. */
export const vscode = acquireVsCodeApi();
