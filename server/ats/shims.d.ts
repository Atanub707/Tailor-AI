declare module 'playwright' {
  export interface Page {
    url(): string;
    goto(url: string, opts?: any): Promise<any>;
    getByLabel(text: string): any;
    locator(selector: string): any;
    evaluate(fn: any): Promise<any>;
    screenshot(opts?: any): Promise<Buffer>;
    waitForLoadState(state?: string): Promise<void>;
    content(): Promise<string>;
  }
  export interface BrowserContext {
    newPage(): Promise<Page>;
    addInitScript(fn: any): Promise<void>;
    close(): Promise<void>;
  }
  export interface Browser {
    newContext(opts?: any): Promise<BrowserContext>;
    isConnected(): boolean;
    close(): Promise<void>;
  }
  export const chromium: {
    launch(opts?: any): Promise<Browser>;
  };
}
