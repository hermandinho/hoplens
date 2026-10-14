# @hoplens/next

Next.js adapter for [Hoplens](https://hoplens.dev). Wrap your Next.js config to light up the `/__hoplens` request-journey view during `next dev`.

```ts
// next.config.ts
import { withHoplens } from "@hoplens/next";

export default withHoplens({ /* your Next.js config */ });
```

Dev-only. Production builds and `next start` are untouched.
