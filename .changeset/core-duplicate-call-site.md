---
"@hoplens/core": patch
---

A `duplicate` finding whose repeats each run inside their own call of the same traced function
(`findProduct(id)` called twice) is now owned by the caller and located at the repeat call, the line
that called it the second time, like `n-plus-1` does for loops. Its title names the function ("ran x2
via findProduct()"). Before, it pointed at the function's own declaration, where the code snippet
shows one call and not the repetition. The finding's fingerprint changes for these cases.
