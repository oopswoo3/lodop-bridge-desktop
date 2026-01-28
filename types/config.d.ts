declare module 'config' {
  interface Config {
    get<T = unknown>(path: string): T;
    has(path: string): boolean;
  }
  const config: Config;
  export default config;
}

