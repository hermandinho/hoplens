# e2e

Playwright suite that drives each example app end-to-end: open the UI, send a pre-filled request, assert the journey hops, the response, the error location, function args. Also verifies `next build + next start` emits zero `hoplens` tokens in `.next/server/**`.
