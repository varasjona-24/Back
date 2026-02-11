declare module 'megajs' {
  export const File: {
    fromURL(url: string): {
      name?: string;
      loadAttributes(cb: (error?: Error | null) => void): void;
      download(options?: Record<string, unknown>): NodeJS.ReadableStream;
    };
  };
}
