/** Imported first by the worker entry point, before anything reads the environment. */
if (process.argv.includes("--production")) {
  (process.env as Record<string, string>).NODE_ENV = "production";
}

export {};
