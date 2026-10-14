import { type TransformOptions, shouldTrace, transformSource } from "./index";

function hoplensLoader(this: any, source: string): string {
  const opts: TransformOptions = (typeof this.getOptions === "function" ? this.getOptions() : this.query) || {
    root: process.cwd(),
  };
  const file: string = this.resourcePath;
  try {
    if (!shouldTrace(file, source, opts)) return source;
    return transformSource(source, file, opts) ?? source;
  } catch {
    // Never break the user's build.
    return source;
  }
}

module.exports = hoplensLoader;
