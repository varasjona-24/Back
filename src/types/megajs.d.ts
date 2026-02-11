declare module 'megajs' {
  export class Storage {
    constructor(options: {
      email: string;
      password: string;
      secondFactorCode?: string;
      autoload?: boolean;
      autologin?: boolean;
      keepalive?: boolean;
    });
    api: object;
    ready: Promise<unknown>;
  }

  export const File: {
    fromURL(
      url: string,
      extraOpt?: {
        api?: object;
      }
    ): {
      name?: string;
      loadAttributes(cb: (error?: Error | null) => void): void;
      download(options?: Record<string, unknown>): NodeJS.ReadableStream;
    };
  };
}
