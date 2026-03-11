declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf-8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: 'utf-8'): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

declare const process: {
  uptime: () => number;
  platform: string;
  env?: Record<string, string | undefined>;
};
